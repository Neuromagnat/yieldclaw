import { Connection, Keypair } from "@solana/web3.js";
import { swapSolToToken, swapTokenToSol, TOKENS } from "./jupiter";

export interface RealPosition {
  id: string;
  poolId: string;
  protocol: string;
  poolName: string;
  inputAmountSol: number;
  outputMint: string;
  outputAmount: number; // token amount received
  entryTxSignature: string;
  entryTime: Date;
  entryApy: number;
  entryScore: number;
  exitTxSignature?: string;
  exitTime?: Date;
  exitAmountSol?: number;
  status: "open" | "closed";
}

/**
 * Manages real on-chain positions.
 * For now, "entering a pool" = swapping SOL to USDC (simulating LP entry).
 * Later this will be replaced with actual LP deposit via protocol SDKs.
 *
 * Why USDC? Most LP pools are paired with USDC or SOL.
 * The simplest real action is: SOL -> USDC (enter), USDC -> SOL (exit).
 * This proves the swap pipeline works before we add LP complexity.
 */
export class PositionManager {
  private positions: RealPosition[] = [];
  private connection: Connection;
  private wallet: Keypair;
  private isDevnet: boolean;

  constructor(connection: Connection, wallet: Keypair, isDevnet: boolean) {
    this.connection = connection;
    this.wallet = wallet;
    this.isDevnet = isDevnet;
  }

  getOpenPositions(): RealPosition[] {
    return this.positions.filter(p => p.status === "open");
  }

  getAllPositions(): RealPosition[] {
    return [...this.positions];
  }

  /**
   * Enter a position: swap SOL into USDC.
   * In the future, this will deposit into an actual LP pool.
   */
  async enter(
    poolId: string,
    protocol: string,
    poolName: string,
    amountSol: number,
    apy: number,
    score: number
  ): Promise<RealPosition> {
    const usdcMint = this.isDevnet ? TOKENS.USDC.devnet : TOKENS.USDC.mainnet;

    const result = await swapSolToToken(
      this.connection,
      this.wallet,
      usdcMint,
      amountSol,
      100 // 1% slippage for devnet
    );

    const pos: RealPosition = {
      id: `pos-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      poolId,
      protocol,
      poolName,
      inputAmountSol: amountSol,
      outputMint: usdcMint,
      outputAmount: parseInt(result.outAmount),
      entryTxSignature: result.signature,
      entryTime: new Date(),
      entryApy: apy,
      entryScore: score,
      status: "open",
    };

    this.positions.push(pos);
    return pos;
  }

  /**
   * Exit a position: swap USDC back to SOL.
   */
  async exit(positionId: string): Promise<RealPosition> {
    const pos = this.positions.find(p => p.id === positionId && p.status === "open");
    if (!pos) throw new Error(`Position ${positionId} not found or already closed`);

    const result = await swapTokenToSol(
      this.connection,
      this.wallet,
      pos.outputMint,
      pos.outputAmount,
      100 // 1% slippage for devnet
    );

    pos.exitTxSignature = result.signature;
    pos.exitTime = new Date();
    pos.exitAmountSol = parseInt(result.outAmount) / 1e9; // lamports to SOL
    pos.status = "closed";

    return pos;
  }

  /**
   * Calculate PnL for a position (in SOL).
   * For open positions, this is estimated based on current value.
   * For closed positions, this is actual.
   */
  getPnl(pos: RealPosition): number {
    if (pos.status === "closed" && pos.exitAmountSol !== undefined) {
      return pos.exitAmountSol - pos.inputAmountSol;
    }
    // For open positions, we'd need to check current USDC->SOL rate
    // For now, estimate based on APY and time held
    const hoursHeld = (Date.now() - pos.entryTime.getTime()) / (1000 * 60 * 60);
    const hourlyRate = pos.entryApy / 100 / 8760;
    return pos.inputAmountSol * hourlyRate * hoursHeld;
  }
}
