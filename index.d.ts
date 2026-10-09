import type { Plugin, SolanaAgentKit } from "solana-agent-kit";

/**
 * A read-only capability over the VaultBags public agent surface. `agent` is
 * optional and only read for a base-URL override (config.OTHER_API_KEYS
 * .VAULTBAGS_API_URL); pass nothing to hit production. Resolves to the tool's
 * JSON payload.
 */
export type VaultBagsMethod<Input = void> = Input extends void
  ? (agent?: SolanaAgentKit) => Promise<Record<string, any>>
  : (agent: SolanaAgentKit | undefined, input: Input) => Promise<Record<string, any>>;

export interface VaultBagsMethods {
  getTodaysAllocation: VaultBagsMethod;
  getDailyBriefing: VaultBagsMethod;
  getTreasuryStats: VaultBagsMethod;
  getDecisionHistory: VaultBagsMethod<{ days?: number }>;
  getMarketSignals: VaultBagsMethod;
  getBrainVsFlat: VaultBagsMethod;
  simulateAllocation: VaultBagsMethod<{
    realYield?: number;
    breakevenInfl?: number;
    dxyChangePct?: number;
    goldMomentumPct?: number;
    hyOas?: number;
    vix?: number;
    spx30dPct?: number;
    tenYear?: number;
    curve10y2y?: number;
    fearGreed?: number;
  }>;
  getProjects: VaultBagsMethod;
  getProjectTreasury: VaultBagsMethod<{ mint: string }>;
  getAgent: VaultBagsMethod<{ mint: string }>;
  getVaultDocs: VaultBagsMethod;
  listRwas: VaultBagsMethod<{ category?: "gold" | "treasury" | "equity-index" | "equity"; issuer?: "backed" | "ondo" | "oro" }>;
  getRwa: VaultBagsMethod<{ query: string }>;
  getProtocolMeter: VaultBagsMethod;
  getAutonomy: VaultBagsMethod;
  getAutonomySpec: VaultBagsMethod;
  getAgentPassport: VaultBagsMethod;
  getRwaPerformance: VaultBagsMethod;
  getShadowVsBrain: VaultBagsMethod;
  getRecentCycles: VaultBagsMethod<{ limit?: number }>;
  getMonthlyReports: VaultBagsMethod<{ months?: number }>;
  getProofOfReserves: VaultBagsMethod;
  getPayoutIntegrity: VaultBagsMethod;
  /** With `days`, the tier a lock term reaches; with `wallet`, the tier it holds. Both optional. */
  getLockTier: VaultBagsMethod<{ days?: number; wallet?: string }>;
  /** `days` 1-365 (default 30), `points` 2-200 samples (default 60). */
  getTreasuryHistory: VaultBagsMethod<{ days?: number; points?: number }>;
  getHolderDistribution: VaultBagsMethod;
  getRecentActivity: VaultBagsMethod;
  verifyClaim: VaultBagsMethod<{ tx: string }>;
  simulateLockBoost: VaultBagsMethod<{ amount?: number }>;
  verifyDay: VaultBagsMethod<{ period?: string }>;
  verifyDecision: VaultBagsMethod<{ date?: string }>;
  getLiquidity: VaultBagsMethod;
  getSupply: VaultBagsMethod;
  getRaffle: VaultBagsMethod;
  getStrategies: VaultBagsMethod;
  /** A preset name (classic, growth, hard-money, income) or a 64-hex strategy key. */
  getStrategy: VaultBagsMethod<{ strategy: string }>;
  /**
   * Verify a receipt from the `X-X402-Receipt` header of a paid call: the
   * signature against the issuer's published key, the claims against their own
   * rules, and the destination against the lane's live terms. `paymentProvenHere`
   * is always false: a signature proves who issued the receipt, the transaction
   * on Solana proves the payment.
   */
  verifyReceipt: VaultBagsMethod<{ receipt: string; answer?: string; question?: string; content?: unknown }>;
}

/** The raw read-only methods, also exposed as the plugin's `methods`. */
export declare const methods: VaultBagsMethods;

/** The VaultBags plugin for Solana Agent Kit v2. Default export. */
declare const VaultBagsPlugin: Plugin;
export default VaultBagsPlugin;
