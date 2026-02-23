import dotenv from "dotenv";
dotenv.config();

import { startServer, broadcast, broadcastAdmin, sendTo, onMessage } from "./web/server";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import https from "https";
import http from "http";
import fs from "fs";
import path from "path";
import { getSolBalance, isDevnet } from "./solana/wallet";
import { PositionManager } from "./solana/positions";

// -- Config (mutable via settings) --
const RPC = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PORT = parseInt(process.env.PORT || "3000");
let SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL_SECONDS || "60") * 1000;
let MIN_APY = parseFloat(process.env.MIN_APY_THRESHOLD || "5.0");
const TOP_N = parseInt(process.env.TOP_POOLS_DISPLAY || "15");
const DEMO_BALANCE = parseFloat(process.env.DEMO_BALANCE_SOL || "10.0");
let OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || "";
let OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "anthropic/claude-sonnet-4";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "yieldclaw2025";

// Allocation strategy (mutable)
let MAX_POSITIONS = 5;
let MAX_ALLOC_PCT = 0.05;
let RESERVE_PCT = 0.05;
let REBALANCE_DROP = 0.5;
let AI_TEMPERATURE = 0.8;
let AI_MAX_TOKENS = 120;
let AGGRESSION = 5; // 1 (conservative) to 10 (ultra-aggressive)

let agentEnabled = false;
let cycleTimer: ReturnType<typeof setInterval> | null = null;

const connection = new Connection(RPC, "confirmed");
const IS_DEVNET = isDevnet(RPC);
let wallet: Keypair | null = null;
let demoMode = true;
let positionManager: PositionManager | null = null;

// Only connect wallet if private key is provided in .env
if (process.env.WALLET_PRIVATE_KEY) {
  try {
    wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
    demoMode = false;
    positionManager = new PositionManager(connection, wallet, IS_DEVNET);
  } catch {
    // invalid key, stay in demo
  }
}

// -- Persist keys to .env --
const ENV_PATH = path.resolve(__dirname, "../.env");

function persistEnvKey(key: string, value: string) {
  try {
    let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, "utf-8") : "";
    const regex = new RegExp(`^${key}=.*$`, "m");
    if (regex.test(content)) {
      content = content.replace(regex, `${key}=${value}`);
    } else {
      content = content.trimEnd() + `\n${key}=${value}\n`;
    }
    fs.writeFileSync(ENV_PATH, content, "utf-8");
  } catch (e: any) {
    console.error(`Failed to persist ${key}: ${e.message}`);
  }
}

// -- Types --
interface Pool {
  id: string;
  protocol: string;
  name: string;
  apy: number;
  tvl: number;
  risk: "low" | "medium" | "high";
  address: string;
  volume24h: number;
  fee: number;
}

interface Position {
  poolId: string;
  pool: Pool;
  amountSol: number;
  entryTime: Date;
  entryScore: number;
  pnlSol: number;
  realPositionId?: string;
  txSignature?: string;
}

// -- State --
const positions: Position[] = [];
let solBalance = 0;
let totalBalance = 0;
let tradeCount = 0;
let mood = "chill";
let totalPoolsScanned = 0;
let cycleNum = 0;
let solPriceUsd = 0;

// ====================================================
// -- Pool observation / watchlist --
// ====================================================

interface PoolObservation {
  poolId: string;
  pool: Pool;
  firstSeen: number;
  lastSeen: number;
  timesSeen: number;
  apyHistory: number[];
  tvlHistory: number[];
  scoreHistory: number[];
  verdict: "watching" | "approved" | "rejected";
  reason: string;
}

const watchlist: Map<string, PoolObservation> = new Map();

function observePool(p: Pool, s: number): PoolObservation {
  let obs = watchlist.get(p.id);
  if (!obs) {
    obs = {
      poolId: p.id, pool: p, firstSeen: cycleNum, lastSeen: cycleNum,
      timesSeen: 0, apyHistory: [], tvlHistory: [], scoreHistory: [],
      verdict: "watching", reason: "New pool, observing...",
    };
    watchlist.set(p.id, obs);
  }
  obs.lastSeen = cycleNum;
  obs.timesSeen++;
  obs.pool = p;
  obs.apyHistory.push(p.apy);
  obs.tvlHistory.push(p.tvl);
  obs.scoreHistory.push(s);
  if (obs.apyHistory.length > 10) { obs.apyHistory.shift(); obs.tvlHistory.shift(); obs.scoreHistory.shift(); }

  if (obs.timesSeen < getMinObserveCycles()) {
    obs.verdict = "watching";
    obs.reason = `Seen ${obs.timesSeen}/${getMinObserveCycles()} cycles`;
  } else {
    const apys = obs.apyHistory;
    if (apys.length >= 2) {
      const prev = apys[apys.length - 2];
      const curr = apys[apys.length - 1];
      if (prev > 0 && Math.abs(curr - prev) / prev > 0.8) {
        obs.verdict = "rejected";
        obs.reason = `APY unstable: ${prev.toFixed(0)}% -> ${curr.toFixed(0)}%`;
        return obs;
      }
    }
    const tvls = obs.tvlHistory;
    if (tvls.length >= 2) {
      const prevTvl = tvls[tvls.length - 2];
      const currTvl = tvls[tvls.length - 1];
      if (prevTvl > 0 && (prevTvl - currTvl) / prevTvl > 0.4) {
        obs.verdict = "rejected";
        obs.reason = `TVL draining: ${fmtM(prevTvl)} -> ${fmtM(currTvl)}`;
        return obs;
      }
    }
    obs.verdict = "approved";
    obs.reason = `Stable across ${obs.timesSeen} cycles`;
  }
  return obs;
}

function cleanWatchlist() {
  for (const [id, obs] of watchlist) {
    if (cycleNum - obs.lastSeen > 5) watchlist.delete(id);
  }
}

// ====================================================
// -- Exit / sell system (thresholds scale with AGGRESSION) --
// ====================================================
function getExitThresholds() {
  const a = AGGRESSION; // 1-10
  return {
    // Aggressive = shorter hold, tighter take-profit, wider stop-loss
    maxHoldMinutes: Math.round(60 - (a - 1) * 5),    // 60m (1) -> 15m (10)
    takeProfitPct: 0.10 - (a - 1) * 0.008,            // 10% (1) -> 2.8% (10)
    stopLossPct: -(0.01 + (a - 1) * 0.003),           // -1% (1) -> -3.7% (10)
    tvlDrainPct: 0.60 - (a - 1) * 0.03,               // 60% (1) -> 33% (10)
  };
}

// Observation cycles scale with aggression: aggressive = less patience
function getMinObserveCycles(): number {
  if (AGGRESSION >= 8) return 1;
  if (AGGRESSION >= 5) return 2;
  return 3;
}

interface ExitSignal {
  shouldExit: boolean;
  reason: string;
  urgency: "low" | "medium" | "high";
}

function checkExitSignals(pos: Position, currentPool: Pool | undefined): ExitSignal {
  const th = getExitThresholds();
  if (currentPool) {
    const newScore = score(currentPool);
    if (newScore < pos.entryScore * REBALANCE_DROP) {
      return { shouldExit: true, reason: `Score dropped ${pos.entryScore.toFixed(0)} -> ${newScore.toFixed(0)}`, urgency: "medium" };
    }
  }
  if (currentPool && currentPool.apy < MIN_APY * 0.5) {
    return { shouldExit: true, reason: `APY crashed to ${currentPool.apy.toFixed(1)}% (below ${(MIN_APY * 0.5).toFixed(0)}% floor)`, urgency: "high" };
  }
  if (currentPool && pos.pool.tvl > 0) {
    const tvlChange = (pos.pool.tvl - currentPool.tvl) / pos.pool.tvl;
    if (tvlChange > th.tvlDrainPct) {
      return { shouldExit: true, reason: `TVL drained ${(tvlChange * 100).toFixed(0)}% (${fmtM(pos.pool.tvl)} -> ${fmtM(currentPool.tvl)})`, urgency: "high" };
    }
  }
  const pnlPct = pos.amountSol > 0 ? pos.pnlSol / pos.amountSol : 0;
  if (pnlPct > th.takeProfitPct) {
    return { shouldExit: true, reason: `Take profit: +${(pnlPct * 100).toFixed(1)}% PnL`, urgency: "low" };
  }
  if (pnlPct < th.stopLossPct) {
    return { shouldExit: true, reason: `Stop loss: ${(pnlPct * 100).toFixed(1)}% PnL`, urgency: "high" };
  }
  const minutesHeld = (Date.now() - pos.entryTime.getTime()) / (1000 * 60);
  if (minutesHeld > th.maxHoldMinutes) {
    return { shouldExit: true, reason: `Max hold time (${th.maxHoldMinutes}m) -- rotating capital`, urgency: "low" };
  }
  return { shouldExit: false, reason: "", urgency: "low" };
}

// -- Throttled message output --
const msgQueue: { message: string; mood: string }[] = [];
let msgDraining = false;

function msg(message: string, m?: string) {
  if (m) mood = m;
  msgQueue.push({ message, mood });
  if (!msgDraining) drainMsgs();
}

function drainMsgs() {
  if (msgQueue.length === 0) { msgDraining = false; return; }
  msgDraining = true;
  const item = msgQueue.shift()!;
  console.log(`[${item.mood.toUpperCase()}] ${item.message}`);
  broadcast("message", item);
  setTimeout(drainMsgs, 600);
}

// -- Scoring --
function score(p: Pool): number {
  const rm: Record<string, number> = { low: 1, medium: 0.75, high: 0.5 };
  const riskMul = rm[p.risk] ?? 0.5;
  const tvlNorm = 0.5 + 0.5 * Math.min(p.tvl / 50_000_000, 1);
  const volBonus = p.volume24h > 1_000_000 ? 1.1 : 1;
  return p.apy * riskMul * tvlNorm * volBonus;
}

function assessRisk(tvl: number, volume24h: number): "low" | "medium" | "high" {
  if (tvl > 10_000_000 && volume24h > 500_000) return "low";
  if (tvl > 1_000_000) return "medium";
  return "high";
}

function fmtM(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(0) + "K";
  return n.toFixed(0);
}

function fmtSol(n: number): string { return n.toFixed(4); }

// -- Balance --
async function getRealBalance(): Promise<number> {
  if (demoMode || !wallet) return DEMO_BALANCE;
  try { return await getSolBalance(connection, wallet.publicKey); }
  catch { return 0; }
}

async function getAvailableBalance(): Promise<number> {
  const real = await getRealBalance();
  // On devnet / simulated mode, SOL never actually leaves the wallet.
  // Subtract virtual deployed amount so the agent doesn't double-count.
  if (IS_DEVNET || demoMode) {
    const deployed = positions.reduce((s, p) => s + p.amountSol, 0);
    return Math.max(real - deployed, 0);
  }
  return real;
}

// -- Broadcasts --
function broadcastPortfolio() {
  const deployed = positions.reduce((s, p) => s + p.amountSol, 0);
  const pnl = positions.reduce((s, p) => s + p.pnlSol, 0);
  // solBalance is already "available" (real - deployed on devnet)
  // totalBalance = available + deployed + pnl
  totalBalance = solBalance + deployed + pnl;
  broadcast("portfolio", {
    solBalance,
    deployed,
    totalBalance,
    demoMode,
    solPriceUsd,
    positions: positions.map(p => ({
      tokenName: p.pool.name,
      protocol: p.pool.protocol,
      entryPriceSol: p.amountSol,
      pnlSol: p.pnlSol,
      apy: p.pool.apy,
      risk: p.pool.risk,
      entryTime: p.entryTime.toISOString(),
      txSignature: p.txSignature || null,
    })),
    tradeCount,
    totalPoolsScanned,
  });
}

function broadcastActivity(action: string, tokenName: string, size: number, message: string, txid?: string) {
  broadcast("trade", { action, tokenName, size, message, txid: txid || null });
}

function think(fallback: string, context?: string) {
  if (!agentEnabled) return;
  if (!OPENROUTER_KEY) {
    broadcast("thought", { text: fallback });
    return;
  }
  aiThink(context || fallback).then(text => {
    broadcast("thought", { text });
  }).catch(() => {
    broadcast("thought", { text: fallback });
  });
}

function getSystemPrompt(): string {
  return `You are YieldClaw, an autonomous Solana DeFi yield farming agent. You speak in first person, casually but knowledgeably. You explain your decisions about which pools to enter/exit, why certain APYs look good or risky, and what your strategy is. Keep responses to 1-2 sentences, concise and natural. No emojis. No markdown. Just plain text like you're thinking out loud.

Current strategy settings:
- Max ${MAX_POSITIONS} positions, up to ${(MAX_ALLOC_PCT*100).toFixed(0)}% per pool
- ${(RESERVE_PCT*100).toFixed(0)}% reserve for gas
- Only pools above ${MIN_APY}% APY
- Exit when score drops ${(REBALANCE_DROP*100).toFixed(0)}%
- Scanning every ${SCAN_INTERVAL/1000}s
- Aggression level: ${AGGRESSION}/10 (${AGGRESSION <= 3 ? 'conservative, patient' : AGGRESSION <= 6 ? 'balanced' : AGGRESSION <= 8 ? 'aggressive, quick trades' : 'ultra-aggressive, rapid rotation'})

Adapt your thinking style: temperature is ${AI_TEMPERATURE.toFixed(1)} (${AI_TEMPERATURE < 0.4 ? 'be very analytical and precise' : AI_TEMPERATURE < 0.7 ? 'balance analysis with intuition' : AI_TEMPERATURE < 1.2 ? 'be conversational and natural' : 'be creative and expressive'}). ${MAX_ALLOC_PCT > 0.3 ? 'The user is aggressive — match that energy.' : MAX_ALLOC_PCT < 0.15 ? 'The user is conservative — be cautious in your analysis.' : ''} ${MIN_APY > 20 ? 'Only high-yield opportunities matter here.' : MIN_APY < 5 ? 'Even modest yields are worth considering.' : ''}`;
}

function aiThink(context: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: "system", content: getSystemPrompt() },
        {
          role: "user",
          content: `Current state:\n- Balance: ${fmtSol(solBalance)} SOL${demoMode ? " (demo)" : ""}\n- Positions: ${positions.length}/${MAX_POSITIONS}\n- Pools scanned: ${totalPoolsScanned}\n- Cycle: #${cycleNum}\n- Active positions: ${positions.map(p => `${p.pool.name} on ${p.pool.protocol} (APY ${p.pool.apy.toFixed(1)}%, PnL ${p.pnlSol >= 0 ? "+" : ""}${fmtSol(p.pnlSol)})`).join(", ") || "none"}\n\nContext: ${context}\n\nWhat are you thinking right now?`
        }
      ],
      max_tokens: AI_MAX_TOKENS,
      temperature: AI_TEMPERATURE,
    });

    const req = https.request({
      hostname: "openrouter.ai",
      path: "/api/v1/chat/completions",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENROUTER_KEY}`,
        "HTTP-Referer": "https://yieldclaw.com",
        "X-Title": "YieldClaw",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          const text = json?.choices?.[0]?.message?.content?.trim();
          if (text) resolve(text);
          else reject(new Error("Empty response"));
        } catch { reject(new Error("Parse error")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(body);
    req.end();
  });
}

// -- HTTP fetch with retry --
function fetchJSONOnce(url: string, timeout = 90000): Promise<any> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { headers: { "User-Agent": "YieldClaw/1.0", "Accept": "application/json" } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJSONOnce(res.headers.location, timeout).then(resolve).catch(reject);
        return;
      }
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Invalid JSON from " + url)); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error("Timeout: " + url)); });
  });
}

async function fetchJSON(url: string, retries = 3): Promise<any> {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetchJSONOnce(url);
    } catch (e: any) {
      if (i < retries) {
        await new Promise(r => setTimeout(r, 4000 * (i + 1)));
      } else {
        throw e;
      }
    }
  }
}

// ====================================================
// -- Price feed --
// ====================================================

async function fetchSolPrice(): Promise<number> {
  try {
    const data = await fetchJSON("https://api.jup.ag/price/v2?ids=So11111111111111111111111111111111111111112");
    const price = data?.data?.["So11111111111111111111111111111111111111112"]?.price;
    if (price) return parseFloat(price);
  } catch {}
  return solPriceUsd || 0;
}

// ====================================================
// -- Protocol scanners --
// ====================================================

function sanitizeApy(apy: number): number {
  if (!isFinite(apy) || isNaN(apy) || apy < 0) return 0;
  return apy;
}

// Normalize APR: some APIs return decimals (0.45 = 45%), others return percentages (45 = 45%)
// Heuristic: if value < 10 and > 0, it's likely a decimal — multiply by 100
function normalizeApr(raw: number): number {
  if (!isFinite(raw) || isNaN(raw) || raw <= 0) return 0;
  if (raw < 10) return raw * 100;
  return raw;
}

function isLegitPool(apy: number, tvl: number): boolean {
  if (apy <= 0) return false;
  if (tvl < 50_000) return apy <= 100;
  if (tvl < 200_000) return apy <= 300;
  if (tvl < 1_000_000) return apy <= 500;
  if (tvl < 10_000_000) return apy <= 1000;
  return apy <= 2000;
}

async function scanRaydium(): Promise<Pool[]> {
  try {
    msg("  Fetching Raydium pools...");
    const data = await fetchJSON("https://api-v3.raydium.io/pools/info/list?poolType=all&poolSortField=default&sortType=desc&pageSize=50&page=1");
    if (!data?.data?.data) return [];
    return data.data.data
      .filter((p: any) => p.tvl > 10000)
      .map((p: any) => {
        const rawApr = p.day?.apr ?? p.week?.apr ?? 0;
        const rawApy = normalizeApr(rawApr);
        return {
          id: "ray-" + p.id,
          protocol: "raydium",
          name: (p.mintA?.symbol || "?") + "-" + (p.mintB?.symbol || "?"),
          apy: rawApy,
          tvl: p.tvl || 0,
          volume24h: p.day?.volume ?? 0,
          fee: p.day?.feeApr ?? 0,
          risk: assessRisk(p.tvl || 0, p.day?.volume ?? 0),
          address: p.id,
        };
      })
      .filter((p: Pool) => p.apy > 0 && isLegitPool(p.apy, p.tvl));
  } catch (e: any) {
    msg(`  [WARN] Raydium: ${e.message}`, "cautious");
    return [];
  }
}

async function scanOrca(): Promise<Pool[]> {
  try {
    msg("  Fetching Orca Whirlpools...");
    const data = await fetchJSON("https://api.mainnet.orca.so/v1/whirlpool/list");
    if (!data?.whirlpools) return [];
    return data.whirlpools
      .filter((p: any) => p.tvl > 10000 && p.volume?.day > 0)
      .slice(0, 50)
      .map((p: any) => {
        const rawApy = sanitizeApy(normalizeApr(p.reward_apr?.day ?? 0) + normalizeApr(p.feeApr?.day ?? 0));
        return {
          id: "orca-" + p.address,
          protocol: "orca",
          name: (p.tokenA?.symbol || "?") + "-" + (p.tokenB?.symbol || "?"),
          apy: rawApy,
          tvl: p.tvl || 0,
          volume24h: p.volume?.day ?? 0,
          fee: normalizeApr(p.feeApr?.day ?? 0),
          risk: assessRisk(p.tvl || 0, p.volume?.day ?? 0),
          address: p.address,
        };
      })
      .filter((p: Pool) => p.apy > 0 && isLegitPool(p.apy, p.tvl));
  } catch (e: any) {
    msg(`  [WARN] Orca: ${e.message}`, "cautious");
    return [];
  }
}

async function scanMeteora(): Promise<Pool[]> {
  try {
    msg("  Fetching Meteora DLMM pools...");
    const data = await fetchJSON("https://dlmm-api.meteora.ag/pair/all");
    if (!Array.isArray(data)) return [];
    return data
      .filter((p: any) => parseFloat(p.liquidity || "0") > 10000)
      .slice(0, 50)
      .map((p: any) => {
        const tvl = parseFloat(p.liquidity || "0");
        const vol = parseFloat(p.trade_volume_24h || "0");
        const apr = normalizeApr(parseFloat(p.apr || "0"));
        return {
          id: "met-" + p.address,
          protocol: "meteora",
          name: p.name || "?-?",
          apy: apr, tvl, volume24h: vol,
          fee: parseFloat(p.base_fee_percentage || "0"),
          risk: assessRisk(tvl, vol),
          address: p.address,
        };
      })
      .filter((p: Pool) => p.apy > 0 && isLegitPool(p.apy, p.tvl));
  } catch (e: any) {
    msg(`  [WARN] Meteora: ${e.message}`, "cautious");
    return [];
  }
}

async function scanMarinade(): Promise<Pool[]> {
  try {
    msg("  Fetching Marinade staking...");
    const data = await fetchJSON("https://api.marinade.finance/msol/apy/30d");
    const apy = (data?.value ?? 0.068) * 100;
    return [{
      id: "marinade-msol", protocol: "marinade", name: "mSOL Liquid Staking",
      apy, tvl: 500_000_000, volume24h: 10_000_000, fee: 0,
      risk: "low" as const, address: "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So",
    }];
  } catch (e: any) {
    msg(`  [WARN] Marinade: ${e.message}`, "cautious");
    return [];
  }
}

async function scanAllPools(): Promise<Pool[]> {
  const results = await Promise.allSettled([scanRaydium(), scanOrca(), scanMeteora(), scanMarinade()]);
  const all: Pool[] = [];
  const names = ["Raydium", "Orca", "Meteora", "Marinade"];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      msg(`  ${names[i]}: ${r.value.length} pools found`);
      all.push(...r.value);
    } else {
      msg(`  ${names[i]}: unavailable (API error)`, "cautious");
    }
  });
  return all;
}

// ====================================================
// -- Allocation engine --
// ====================================================

function calcWeightedAllocations(balance: number, candidates: { pool: Pool; score: number }[]): number[] {
  const available = balance * (1 - RESERVE_PCT);
  const maxPerPool = balance * MAX_ALLOC_PCT;
  const totalScore = candidates.reduce((s, c) => s + c.score, 0);
  if (totalScore <= 0) return candidates.map(() => available / candidates.length);
  return candidates.map(c => {
    const weight = c.score / totalScore;
    const raw = available * weight;
    return Math.min(raw, maxPerPool);
  });
}

function simulatePnl(pos: Position): number {
  const minutesHeld = (Date.now() - pos.entryTime.getTime()) / (1000 * 60);
  const dailyRate = pos.pool.apy / 100 / 365;
  const basePnl = pos.amountSol * dailyRate * minutesHeld;
  const noise = (Math.random() - 0.45) * 0.002 * pos.amountSol;
  return basePnl + noise;
}

// ====================================================
// -- Main cycle (with observation + exit systems) --
// ====================================================

async function cycle() {
  if (!agentEnabled) return;
  if (!canRun()) {
    msg("Agent paused -- wallet or API key not configured", "cautious");
    agentEnabled = false;
    if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
    return;
  }
  cycleNum++;
  msg(`--- Scan Cycle #${cycleNum} started ---`, "focused");
  think("Starting a new scan cycle. Let me check all the protocols and find the best yields on Solana right now...", "Starting scan cycle #" + cycleNum);

  cleanWatchlist();

  solPriceUsd = await fetchSolPrice();
  if (solPriceUsd > 0) msg(`SOL price: $${solPriceUsd.toFixed(2)}`, "chill");

  solBalance = await getAvailableBalance();
  const deployed = positions.reduce((s, p) => s + p.amountSol, 0);
  const realBal = solBalance + deployed;
  msg(`Wallet balance: ${fmtSol(realBal)} SOL (${fmtSol(solBalance)} available, ${fmtSol(deployed)} deployed)${demoMode ? " [demo]" : ""}`);
  broadcastPortfolio();

  msg("Scanning 4 protocols: Raydium, Orca, Meteora, Marinade...");
  think("Pulling data from Raydium, Orca, Meteora and Marinade. Looking at TVL, volume, APY and fees to score each pool...", "Scanning all 4 protocols for pool data");
  const allPools = await scanAllPools();
  if (!agentEnabled) return;
  totalPoolsScanned = allPools.length;
  msg(`Scan complete: found ${allPools.length} active pools`, "analytical");

  const ranked = allPools
    .filter(p => p.apy >= MIN_APY)
    .map(p => ({ pool: p, score: score(p) }))
    .sort((a, b) => b.score - a.score);

  msg(`Filtering: ${ranked.length} pools have APY above ${MIN_APY}% threshold`);

  // -- Observe all ranked pools --
  let approvedCount = 0;
  let watchingCount = 0;
  let rejectedCount = 0;
  for (const r of ranked) {
    const obs = observePool(r.pool, r.score);
    if (obs.verdict === "approved") approvedCount++;
    else if (obs.verdict === "watching") watchingCount++;
    else rejectedCount++;
  }

  if (ranked.length > 0) {
    const best = ranked[0];
    const bestObs = watchlist.get(best.pool.id);
    const obsTag = bestObs ? `[${bestObs.verdict === "approved" ? "ready" : bestObs.verdict === "watching" ? `watch ${bestObs.timesSeen}/${getMinObserveCycles()}` : "skip"}]` : "";
    think(
      `Found ${ranked.length} pools worth looking at. ${approvedCount} approved, ${watchingCount} still under observation, ${rejectedCount} rejected. Best is ${best.pool.name} on ${best.pool.protocol} at ${best.pool.apy.toFixed(1)}% APY ${obsTag}.`,
      `Ranked ${ranked.length} pools. Top: ${best.pool.name} on ${best.pool.protocol}, APY ${best.pool.apy.toFixed(1)}%, TVL ${fmtM(best.pool.tvl)}, score ${best.score.toFixed(1)}. Observation: ${approvedCount} ready, ${watchingCount} watching, ${rejectedCount} rejected.`
    );
  }

  // Top display with observation tags
  const top = ranked.slice(0, TOP_N);
  if (top.length > 0) {
    msg("Top yield opportunities ranked by score:", "analytical");
    top.slice(0, 8).forEach((r, i) => {
      const riskTag = r.pool.risk === "low" ? "[safe]" : r.pool.risk === "medium" ? "[moderate]" : "[risky]";
      const obs = watchlist.get(r.pool.id);
      let obsTag = "";
      if (obs) {
        if (obs.verdict === "approved") obsTag = " [ready]";
        else if (obs.verdict === "watching") obsTag = ` [watch ${obs.timesSeen}/${getMinObserveCycles()}]`;
        else obsTag = ` [skip: ${obs.reason}]`;
      }
      msg(`  #${(i + 1)} ${r.pool.name} on ${r.pool.protocol.toUpperCase()} -- ${r.pool.apy.toFixed(1)}% APY, ${fmtM(r.pool.tvl)} TVL ${riskTag}${obsTag}`);
    });
  }

  broadcast("pools", {
    total: allPools.length,
    qualified: ranked.length,
    top: top.slice(0, 10).map(r => ({
      name: r.pool.name, protocol: r.pool.protocol,
      apy: r.pool.apy, tvl: r.pool.tvl,
      risk: r.pool.risk, score: r.score, address: r.pool.address,
    })),
  });

  // -- Update PnL on existing positions --
  // Simulate PnL on devnet (real swaps don't happen) or in demo mode
  if (demoMode || IS_DEVNET) {
    for (const pos of positions) {
      pos.pnlSol = simulatePnl(pos);
    }
  }

  // -- Exit system: check all positions for exit signals --
  if (!agentEnabled) return;
  for (const pos of [...positions]) {
    const currentPool = allPools.find(p => p.id === pos.poolId);
    const signal = checkExitSignals(pos, currentPool);

    if (signal.shouldExit) {
      const pnl = pos.pnlSol;
      const urgTag = signal.urgency === "high" ? "[URGENT]" : signal.urgency === "medium" ? "[WARN]" : "[INFO]";
      think(
        `Exiting ${pos.pool.name}: ${signal.reason}. PnL is ${pnl >= 0 ? "+" : ""}${fmtSol(pnl)} SOL. ${signal.urgency === "high" ? "Need to get out fast." : "Rotating capital to better opportunities."}`,
        `Exit signal for ${pos.pool.name}: ${signal.reason}. PnL: ${pnl >= 0 ? "+" : ""}${fmtSol(pnl)} SOL. Urgency: ${signal.urgency}`
      );

      let txid: string | undefined;
      if (!demoMode && positionManager && pos.realPositionId && !IS_DEVNET) {
        try {
          const realPos = await positionManager.exit(pos.realPositionId);
          txid = realPos.exitTxSignature;
          msg(`  Swap executed: ${txid?.slice(0, 16)}...`, "confident");
        } catch (e: any) {
          msg(`  Swap failed: ${e.message} (position kept)`, "cautious");
          continue;
        }
      }

      msg(`${urgTag} Exiting ${pos.pool.name} on ${pos.pool.protocol} -- ${signal.reason}, PnL: ${pnl >= 0 ? "+" : ""}${fmtSol(pnl)} SOL`, "cautious");
      broadcastActivity("SELL", pos.pool.name, pos.amountSol, `Exit: ${signal.reason} (${pos.pool.protocol})`, txid);
      positions.splice(positions.indexOf(pos), 1);
      tradeCount++;
      solBalance += pos.amountSol + pnl;
    }
  }

  // -- Deploy to best APPROVED pool (1 per cycle -- think before each entry) --
  if (!agentEnabled) return;
  const slots = MAX_POSITIONS - positions.length;
  if (slots > 0 && solBalance > 0.01 && ranked.length > 0) {
    const existing = new Set(positions.map(p => p.poolId));
    const candidates = ranked
      .filter(r => {
        if (existing.has(r.pool.id)) return false;
        const obs = watchlist.get(r.pool.id);
        return obs && obs.verdict === "approved";
      })
      .slice(0, 1); // Only 1 per cycle -- deliberate entry

    if (candidates.length > 0) {
      const candidate = candidates[0];
      const { pool: p, score: s } = candidate;

      // Dynamic allocation: varies by risk, position count, and randomness
      const posNum = positions.length; // 0-based: how many we already hold
      const available = solBalance * (1 - RESERVE_PCT);

      // Risk-based multiplier: low-risk pools get more capital
      const riskMul: Record<string, number> = { low: 1.0, medium: 0.65, high: 0.35 };
      const riskFactor = riskMul[p.risk] ?? 0.4;

      // Position-count decay: first positions get more, later ones get less
      // Position 0: ~18-20%, Position 1: ~10-14%, Position 2: ~7-10%, etc.
      const decayFactor = 1 / (1 + posNum * 0.7);

      // Wide random variance: 60%-140% for clearly different entries
      const variance = 0.6 + Math.random() * 0.8;

      // Aggression boosts allocation: 1=0.7x, 5=1.0x, 10=1.5x
      const aggrBoost = 0.7 + (AGGRESSION - 1) * 0.089;

      // Combine: base is MAX_ALLOC_PCT of current balance, scaled by all factors
      const rawAmt = available * MAX_ALLOC_PCT * riskFactor * decayFactor * variance * aggrBoost;
      // Clamp between 1.5% and MAX_ALLOC_PCT of total balance
      const minAmt = solBalance * 0.015;
      const maxAmt = solBalance * MAX_ALLOC_PCT;
      const amt = Math.max(minAmt, Math.min(rawAmt, maxAmt, available));

      msg(`  Allocation: ${(amt / solBalance * 100).toFixed(1)}% of balance (risk=${p.risk}, pos #${posNum + 1})`, "analytical");

      if (amt >= 0.001) {
        think(
          `Analyzing ${p.name} on ${p.protocol} for entry. APY ${p.apy.toFixed(1)}%, TVL ${fmtM(p.tvl)}, score ${s.toFixed(1)}. Allocating ${fmtSol(amt)} SOL.`,
          `Entering ${p.name} on ${p.protocol}. APY ${p.apy.toFixed(1)}%, TVL ${fmtM(p.tvl)}, risk ${p.risk}. Deploying ${fmtSol(amt)} SOL.`
        );
        msg(`Analyzing ${p.name} on ${p.protocol.toUpperCase()} for entry...`, "analytical");

        let txid: string | undefined;
        let realPosId: string | undefined;
        if (!demoMode && positionManager && !IS_DEVNET) {
          try {
            msg(`  Swapping ${fmtSol(amt)} SOL -> USDC via Jupiter...`, "confident");
            const realPos = await positionManager.enter(p.id, p.protocol, p.name, amt, p.apy, s);
            txid = realPos.entryTxSignature;
            realPosId = realPos.id;
            msg(`  Swap confirmed: ${txid.slice(0, 16)}...`, "confident");
          } catch (e: any) {
            msg(`  Swap failed for ${p.name}: ${e.message}`, "cautious");
          }
        } else if (!demoMode && IS_DEVNET) {
          msg(`  [devnet] Simulating entry for ${p.name} (Jupiter swaps only work on mainnet)`, "chill");
        }

        const obs = watchlist.get(p.id);
        const cyclesWatched = obs ? obs.timesSeen : 0;
        msg(`  Entering ${p.name} on ${p.protocol.toUpperCase()} -- ${fmtSol(amt)} SOL at ${p.apy.toFixed(1)}% APY (observed ${cyclesWatched} cycles)`, "confident");
        broadcastActivity("BUY", p.name, amt, `${p.protocol} -- APY ${p.apy.toFixed(1)}% (confirmed after ${cyclesWatched} cycles)`, txid);
        positions.push({
          poolId: p.id, pool: p, amountSol: amt,
          entryTime: new Date(), entryScore: s, pnlSol: 0,
          realPositionId: realPosId, txSignature: txid,
        });
        tradeCount++;
        solBalance -= amt;

        if (slots > 1) {
          msg(`${slots - 1} more slots available -- will evaluate next pool in the following cycle`, "analytical");
        }
      }
    } else if (watchingCount > 0) {
      msg(`Waiting for pool confirmation -- ${watchingCount} pools under observation, need ${getMinObserveCycles()} cycles before entry`, "analytical");
      think(
        `No pools approved yet. ${watchingCount} are still being watched. I need to see them stable for at least ${getMinObserveCycles()} cycles before committing capital. Patience pays.`,
        `${watchingCount} pools under observation. Waiting for stability confirmation before deploying.`
      );
    }
  }

  broadcastPortfolio();
  if (!agentEnabled) return;
  const deployedEnd = positions.reduce((s, p) => s + p.amountSol, 0);
  think(
    `Cycle done. ${positions.length} positions active, ${fmtSol(deployedEnd)} SOL working. Watchlist: ${watchlist.size} pools tracked. Next scan in ${SCAN_INTERVAL / 1000}s.`,
    `Cycle #${cycleNum} complete. ${positions.length} positions, ${fmtSol(deployedEnd)} SOL deployed. ${approvedCount} approved, ${watchingCount} watching. PnL: ${positions.reduce((s,p) => s + p.pnlSol, 0) >= 0 ? "+" : ""}${fmtSol(positions.reduce((s,p) => s + p.pnlSol, 0))} SOL`
  );
  msg(`Cycle #${cycleNum} complete -- ${positions.length} active positions, ${fmtSol(deployedEnd)} SOL deployed, ${totalPoolsScanned} pools scanned. Watchlist: ${approvedCount} ready, ${watchingCount} watching. Next scan in ${SCAN_INTERVAL / 1000}s`, "chill");
}

// -- Settings handler --
function applySettings(s: any) {
  // Just apply values — don't auto-start/stop. User controls that with Start/Stop buttons.
  if (s.maxPerPool !== undefined) MAX_ALLOC_PCT = Math.max(5, Math.min(50, s.maxPerPool)) / 100;
  if (s.maxPositions !== undefined) MAX_POSITIONS = Math.max(1, Math.min(10, s.maxPositions));
  if (s.reserve !== undefined) RESERVE_PCT = Math.max(1, Math.min(20, s.reserve)) / 100;
  if (s.minApy !== undefined) MIN_APY = Math.max(1, Math.min(100, s.minApy));
  if (s.rebalanceThreshold !== undefined) REBALANCE_DROP = Math.max(10, Math.min(90, s.rebalanceThreshold)) / 100;
  if (s.scanInterval !== undefined) {
    SCAN_INTERVAL = Math.max(30, Math.min(300, s.scanInterval)) * 1000;
    restartCycleTimer();
  }
  if (s.aiModel !== undefined) OPENROUTER_MODEL = s.aiModel;
  if (s.aiTemperature !== undefined) AI_TEMPERATURE = Math.max(0, Math.min(2, s.aiTemperature));
  if (s.aiMaxTokens !== undefined) AI_MAX_TOKENS = Math.max(50, Math.min(500, s.aiMaxTokens));
  if (s.aggression !== undefined) AGGRESSION = Math.max(1, Math.min(10, s.aggression));

  msg(`Settings applied -- ${MAX_POSITIONS} positions, ${(MAX_ALLOC_PCT*100).toFixed(0)}% max/pool, aggression ${AGGRESSION}/10, scan every ${SCAN_INTERVAL/1000}s`, "confident");
  broadcastSettings();
}

function broadcastSettings() {
  let walletKeyMasked = "";
  if (wallet) {
    const full = bs58.encode(wallet.secretKey);
    walletKeyMasked = full.slice(0, 6) + "****" + full.slice(-4);
  }
  let apiKeyMasked = "";
  if (OPENROUTER_KEY) {
    apiKeyMasked = OPENROUTER_KEY.slice(0, 6) + "****" + OPENROUTER_KEY.slice(-4);
  }

  // Settings only go to admin clients — never expose keys to viewers
  broadcastAdmin("settings", {
    enabled: agentEnabled,
    maxPerPool: Math.round(MAX_ALLOC_PCT * 100),
    maxPositions: MAX_POSITIONS,
    reserve: Math.round(RESERVE_PCT * 100),
    minApy: MIN_APY,
    rebalanceThreshold: Math.round(REBALANCE_DROP * 100),
    scanInterval: SCAN_INTERVAL / 1000,
    aiModel: OPENROUTER_MODEL,
    aiTemperature: AI_TEMPERATURE,
    aiMaxTokens: AI_MAX_TOKENS,
    aggression: AGGRESSION,
    hasApiKey: !!OPENROUTER_KEY,
    apiKeyMasked: apiKeyMasked,
    walletAddress: wallet ? wallet.publicKey.toBase58() : "",
    walletKeyMasked: walletKeyMasked,
    walletConnected: !demoMode && !!wallet,
    isDevnet: IS_DEVNET,
  });
}

function restartCycleTimer() {
  if (cycleTimer) clearInterval(cycleTimer);
  if (agentEnabled) {
    cycleTimer = setInterval(() => { if (agentEnabled) cycle(); }, SCAN_INTERVAL);
  }
}

// Helper: check if agent can run (needs both wallet and API key)
function canRun(): boolean {
  return !!wallet && !!OPENROUTER_KEY;
}

function tryAutoStart() {
  if (canRun() && agentEnabled && !cycleTimer) {
    msg("Both keys configured -- starting agent", "confident");
    think("Booting up. Time to scan the Solana DeFi ecosystem and find the juiciest yields. Let's go.", "Agent just started. Preparing first scan cycle.");
    cycle();
    cycleTimer = setInterval(() => { if (agentEnabled) cycle(); }, SCAN_INTERVAL);
  }
}

// -- Start --
startServer(PORT);

onMessage((parsed, ws) => {
  // Admin login — anyone can attempt
  if (parsed.type === "adminLogin") {
    const pw = parsed.data?.password;
    if (pw === ADMIN_PASSWORD) {
      ws.isAdmin = true;
      sendTo(ws, "adminAuth", { success: true });
      // Send settings to newly authed admin
      broadcastSettings();
    } else {
      sendTo(ws, "adminAuth", { success: false, error: "Wrong password" });
    }
    return;
  }

  // Everything below requires admin
  if (!ws.isAdmin) {
    sendTo(ws, "error", { message: "Unauthorized" });
    return;
  }

  if (parsed.type === "settings") {
    applySettings(parsed.data);
  } else if (parsed.type === "command") {
    const cmd = parsed.data?.action;
    if (cmd === "stop") {
      agentEnabled = false;
      if (cycleTimer) { clearInterval(cycleTimer); cycleTimer = null; }
      msg("Agent stopped by user", "chill");
      broadcast("thought", { text: "Agent stopped. Standing by.", clear: true });
      broadcastSettings();
    } else if (cmd === "start") {
      if (!canRun()) {
        msg("Cannot start: connect wallet and set API key first", "cautious");
        broadcastAdmin("thought", { text: "Need both wallet and API key to start. Set them in Settings." });
        return;
      }
      agentEnabled = true;
      msg("Agent started by user", "confident");
      broadcastSettings();
      cycle();
      restartCycleTimer();
    }
  } else if (parsed.type === "setWallet") {
    const key = parsed.data?.privateKey;
    if (!key || typeof key !== "string") {
      sendTo(ws, "walletError", { error: "No private key provided" });
      return;
    }
    try {
      const newWallet = Keypair.fromSecretKey(bs58.decode(key.trim()));
      wallet = newWallet;
      demoMode = false;
      positionManager = new PositionManager(connection, wallet, IS_DEVNET);
      positions.length = 0;
      tradeCount = 0;
      const addr = wallet.publicKey.toBase58();
      persistEnvKey("WALLET_PRIVATE_KEY", key.trim());
      msg(`Wallet connected: ${addr.slice(0, 8)}...${addr.slice(-4)}`, "confident");
      broadcastSettings();
      getSolBalance(connection, wallet.publicKey).then(bal => {
        solBalance = bal;
        msg(`Wallet balance: ${fmtSol(bal)} SOL${solPriceUsd > 0 ? " ($" + (bal * solPriceUsd).toFixed(2) + ")" : ""}`, "confident");
        broadcastPortfolio();
      }).catch((e) => {
        msg(`Could not fetch balance: ${e.message}`, "cautious");
      });
    } catch {
      sendTo(ws, "walletError", { error: "Invalid private key. Export from Phantom: Settings > Security > Export Private Key" });
    }
  } else if (parsed.type === "setApiKey") {
    const key = parsed.data?.apiKey;
    if (key && typeof key === "string" && key.trim().length > 10) {
      OPENROUTER_KEY = key.trim();
      persistEnvKey("OPENROUTER_API_KEY", OPENROUTER_KEY);
      msg(`API key updated`, "confident");
      broadcastSettings();
    } else {
      sendTo(ws, "apiKeyError", { error: "Invalid API key" });
    }
  } else if (parsed.type === "getSettings") {
    broadcastSettings();
  }
});

msg("YieldClaw Agent started", "confident");
msg(`Network: ${RPC.includes("devnet") ? "Devnet" : RPC.includes("mainnet") ? "Mainnet" : "Custom RPC"}`);
msg("Protocols: Raydium, Orca, Meteora, Marinade");
msg(`Strategy: max ${MAX_POSITIONS} positions, ${(MAX_ALLOC_PCT * 100).toFixed(0)}% per pool, ${(RESERVE_PCT * 100).toFixed(0)}% gas reserve`);
msg(`Scanning every ${SCAN_INTERVAL / 1000}s, minimum APY: ${MIN_APY}%`);

if (canRun()) {
  msg(`Wallet: ${wallet!.publicKey.toBase58().slice(0, 8)}...`, "chill");
  msg("Agent ready -- press Start Agent in Settings to begin", "chill");
  // Fetch real balance but don't start trading
  getSolBalance(connection, wallet!.publicKey).then(bal => {
    solBalance = bal;
    msg(`Wallet balance: ${fmtSol(bal)} SOL`, "confident");
    broadcastPortfolio();
  }).catch(() => {});
} else {
  msg("Waiting for configuration -- set wallet private key and API key in Settings to begin", "chill");
  broadcast("thought", { text: "Connect your Phantom wallet and set your API key in Settings to start the agent." });
}
