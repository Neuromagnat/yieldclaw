# 🦀 YieldClaw

Autonomous AI agent that scans the entire Solana DeFi ecosystem in real-time and deploys capital to the highest-yield pools automatically.

![Solana](https://img.shields.io/badge/Solana-Mainnet-9945FF?style=flat&logo=solana)
![License](https://img.shields.io/badge/license-MIT-green)

## What it does

YieldClaw continuously scans liquidity pools across major Solana protocols, ranks them by a composite score (APY × risk × TVL × volume), and automatically enters/exits positions to maximize yield.

**Supported protocols:**
- **Raydium** — AMM & Concentrated Liquidity pools
- **Orca** — Whirlpool concentrated liquidity
- **Meteora** — DLMM dynamic pools
- **Marinade** — mSOL liquid staking

**How it works:**
1. Every cycle (configurable), the agent fetches real pool data from each protocol's API
2. Pools are filtered by minimum APY threshold and ranked by composite score
3. Agent deploys SOL to top-scoring pools (up to 5 simultaneous positions)
4. Positions are monitored — if a pool's score drops significantly, capital is withdrawn and redeployed
5. All activity is streamed live to the web dashboard via WebSocket

## Live Dashboard

Single-page web UI with real-time updates:

- **macOS-style terminal** — live agent logs with animated output
- **Header** — protocol badges, SOL balance, positions, trades, pools scanned, cycle count, uptime
- **Right panel** — portfolio overview, active positions, activity feed
- **Toast notifications** — pop-up alerts when agent enters/exits a pool
- **Agent status bar** — current state (SCANNING/DEPLOYING/IDLE), mood, cycle progress

No frameworks. No React. Just vanilla HTML/JS + WebSocket. Lightweight.

## Quick Start

```bash
# Clone
git clone https://github.com/pichahuiha/yieldclaw.git
cd yieldclaw

# Install
npm install

# Configure
cp .env.example .env
# Edit .env with your settings

# Run
npm run dev
```

Open http://localhost:3000

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com` | Solana RPC endpoint |
| `WALLET_PRIVATE_KEY` | — | Base58 private key (leave empty for observation mode) |
| `PORT` | `3000` | Web server port |
| `SCAN_INTERVAL_SECONDS` | `60` | Seconds between scan cycles |
| `MAX_ALLOCATION_PER_POOL_SOL` | `1.0` | Max SOL to deploy per pool |
| `MIN_APY_THRESHOLD` | `5.0` | Minimum APY % to consider a pool |
| `TOP_POOLS_DISPLAY` | `15` | Number of top pools to show in logs |

## Observation Mode

Without a wallet key, YieldClaw runs in **observation mode** — it scans all pools, ranks them, and shows the best opportunities in the dashboard, but doesn't execute any transactions. Good for monitoring the ecosystem before committing capital.

## Project Structure

```
yieldclaw/
├── src/
│   ├── index.ts          # Agent logic + pool scanning + entry point
│   └── web/
│       ├── server.ts      # Express + WebSocket server
│       └── public/
│           ├── index.html  # Dashboard (single file, no build step)
│           └── logo.png
├── .env.example
├── package.json
└── tsconfig.json
```

Single `node_modules`, single process. No build step for frontend.

## Scoring Algorithm

Each pool is scored by:

```
score = APY × riskMultiplier × tvlNormalized × volumeBonus
```

- **riskMultiplier**: low=1.0, medium=0.75, high=0.5
- **tvlNormalized**: scales from 0.5 to 1.0 based on TVL (capped at $50M)
- **volumeBonus**: 1.1x if 24h volume > $1M

Risk is assessed automatically:
- **Low**: TVL > $10M AND volume > $500K
- **Medium**: TVL > $1M
- **High**: everything else

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **Blockchain**: @solana/web3.js
- **Server**: Express + ws (WebSocket)
- **Frontend**: Vanilla HTML/CSS/JS
- **APIs**: Raydium v3, Orca Whirlpool, Meteora DLMM, Marinade Finance

## License

MIT
