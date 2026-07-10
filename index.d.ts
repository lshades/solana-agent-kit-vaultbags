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
  getVaultDocs: VaultBagsMethod;
  listRwas: VaultBagsMethod<{ category?: "gold" | "treasury" | "equity-index" | "equity"; issuer?: "backed" | "ondo" | "oro" }>;
  getRwa: VaultBagsMethod<{ query: string }>;
  getProtocolMeter: VaultBagsMethod;
  getAutonomy: VaultBagsMethod;
  getAgentPassport: VaultBagsMethod;
  getRwaPerformance: VaultBagsMethod;
  getShadowVsBrain: VaultBagsMethod;
  getRecentCycles: VaultBagsMethod<{ limit?: number }>;
}

/** The raw read-only methods, also exposed as the plugin's `methods`. */
export declare const methods: VaultBagsMethods;

/** The VaultBags plugin for Solana Agent Kit v2. Default export. */
declare const VaultBagsPlugin: Plugin;
export default VaultBagsPlugin;
