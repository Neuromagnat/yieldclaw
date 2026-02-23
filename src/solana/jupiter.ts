import {
  Connection,
  Keypair,
  VersionedTransaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import https from "https";

// Well-known token mints on devnet/mainnet
export const TOKENS: Record<string, { devnet: string; mainnet: string; decimals: number }> = {
  SOL:  { devnet: "So11111111111111111111111111111111111111112", mainnet: "So11111111111111111111111111111111111111112", decimals: 9 },
  USDC: { devnet: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU", mainnet: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", decimals: 6 },
};

const JUPITER_API = "https://quote-api.jup.ag/v6";

interface QuoteResponse {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: string;
  slippageBps: number;
  priceImpactPct: string;
  routePlan: any[];
}

/**
 * Get a swap quote from Jupiter.
 */
export async function getQuote(
  inputMint: string,
  outputMint: string,
  amountLamports: number,
  slippageBps: number = 50
): Promise<QuoteResponse> {
  const url = `${JUPITER_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`;
  return fetchJSON(url);
}

/**
 * Get serialized swap transaction from Jupiter.
 */
async function getSwapTransaction(
  quoteResponse: QuoteResponse,
  userPublicKey: string
): Promise<string> {
  const body = JSON.stringify({
    quoteResponse,
    userPublicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: "auto",
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      `${JUPITER_API}/swap`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json.swapTransaction) resolve(json.swapTransaction);
            else reject(new Error(json.error || "No swap transaction returned"));
          } catch {
            reject(new Error("Failed to parse Jupiter swap response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("Jupiter swap timeout")); });
    req.write(body);
    req.end();
  });
}

/**
 * Execute a swap: SOL -> Token or Token -> SOL.
 * Returns the transaction signature.
 */
export async function executeSwap(
  connection: Connection,
  wallet: Keypair,
  inputMint: string,
  outputMint: string,
  amountLamports: number,
  slippageBps: number = 50
): Promise<{ signature: string; inAmount: string; outAmount: string }> {
  // 1. Get quote
  const quote = await getQuote(inputMint, outputMint, amountLamports, slippageBps);

  // 2. Get swap transaction
  const swapTxBase64 = await getSwapTransaction(quote, wallet.publicKey.toBase58());

  // 3. Deserialize, sign, send
  const txBuf = Buffer.from(swapTxBase64, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet]);

  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });

  // 4. Confirm
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    signature,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });

  return {
    signature,
    inAmount: quote.inAmount,
    outAmount: quote.outAmount,
  };
}

/**
 * Convenience: swap SOL to a token.
 */
export async function swapSolToToken(
  connection: Connection,
  wallet: Keypair,
  outputMint: string,
  solAmount: number,
  slippageBps: number = 50
): Promise<{ signature: string; inAmount: string; outAmount: string }> {
  const lamports = Math.floor(solAmount * LAMPORTS_PER_SOL);
  return executeSwap(
    connection, wallet,
    TOKENS.SOL.mainnet, // SOL mint is same on devnet/mainnet
    outputMint,
    lamports,
    slippageBps
  );
}

/**
 * Convenience: swap a token back to SOL.
 */
export async function swapTokenToSol(
  connection: Connection,
  wallet: Keypair,
  inputMint: string,
  tokenAmount: number, // in smallest unit (lamports/micro-units)
  slippageBps: number = 50
): Promise<{ signature: string; inAmount: string; outAmount: string }> {
  return executeSwap(
    connection, wallet,
    inputMint,
    TOKENS.SOL.mainnet,
    tokenAmount,
    slippageBps
  );
}

// -- Helper --
function fetchJSON(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "Accept": "application/json" } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Invalid JSON from " + url)); }
      });
    }).on("error", reject);
  });
}
