import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs";
import path from "path";

const WALLET_FILE = path.join(process.cwd(), "wallet.json");

/**
 * Load wallet from .env WALLET_PRIVATE_KEY, or from wallet.json,
 * or generate a new one and save it.
 */
export function loadOrCreateWallet(privateKeyEnv?: string): Keypair {
  // 1. Try .env private key
  if (privateKeyEnv) {
    try {
      return Keypair.fromSecretKey(bs58.decode(privateKeyEnv));
    } catch {
      // invalid key, fall through
    }
  }

  // 2. Try wallet.json
  if (fs.existsSync(WALLET_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(WALLET_FILE, "utf-8"));
      return Keypair.fromSecretKey(Uint8Array.from(data));
    } catch {
      // corrupted file, fall through
    }
  }

  // 3. Generate new wallet and save
  const kp = Keypair.generate();
  fs.writeFileSync(WALLET_FILE, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

/**
 * Request SOL airdrop on devnet. Max 2 SOL per request.
 * Returns the amount actually airdropped.
 */
export async function requestAirdrop(
  connection: Connection,
  pubkey: PublicKey,
  amountSol: number = 2
): Promise<number> {
  const lamports = Math.min(amountSol, 2) * LAMPORTS_PER_SOL;
  const sig = await connection.requestAirdrop(pubkey, lamports);
  // Wait for confirmation
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    signature: sig,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Get SOL balance in SOL (not lamports).
 */
export async function getSolBalance(
  connection: Connection,
  pubkey: PublicKey
): Promise<number> {
  const lamports = await connection.getBalance(pubkey);
  return lamports / LAMPORTS_PER_SOL;
}

/**
 * Check if connection is devnet.
 */
export function isDevnet(rpcUrl: string): boolean {
  return rpcUrl.includes("devnet");
}
