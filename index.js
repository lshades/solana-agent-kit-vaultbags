// VaultBags plugin for Solana Agent Kit v2.
//
// Exposes the VaultBags autonomous RWA treasury as agent tools: today's frozen
// allocation and its on-chain receipt, the daily briefing, live treasury stats,
// decision history, the market signals behind each decision, the honest
// brain-vs-flat track record, the projects running on VaultBags, one project's
// treasury by mint, condensed docs, and a client-side run of the vault's own
// allocation model on the caller's inputs.
//
// Everything here is READ-ONLY public data over HTTPS. The plugin never holds a
// key, never signs, never moves funds, and needs no auth. It is a thin wrapper
// over the public REST surface (client.js); tool names, schemas and
// descriptions mirror the VaultBags MCP server verbatim so the two never drift.
//
// Shape (Plugin, Action, Handler) follows Solana Agent Kit v2 exactly:
// https://github.com/sendaifun/solana-agent-kit (packages/core/src/types).

import { z } from "zod";
import { methods } from "./client.js";

// Wrap a capability's JSON in the { status, ... } envelope agent actions use.
// The tool payload is nested under `data` so its own fields (some responses
// carry a `status` of their own) can never clash with the envelope's status.
function ok(data) {
  return { status: "success", data };
}
function fail(error) {
  return { status: "error", message: error?.message || String(error) };
}

// Build a read-only Action from one capability. `run` is (agent, input).
function readAction({ name, similes, description, schema, example, run }) {
  return {
    name,
    similes,
    description,
    examples: [
      [
        {
          input: example?.input || {},
          output: { status: "success", data: example?.output || {} },
          explanation: example?.explanation || description,
        },
      ],
    ],
    schema,
    handler: async (agent, input) => {
      try {
        return ok(await run(agent, input));
      } catch (error) {
        return fail(error);
      }
    },
  };
}

const noInput = z.object({});

// Descriptions are copied verbatim from lib/mcpCore TOOLS in the VaultBags repo
// so an agent sees exactly the same tool contract on MCP and here.

const todaysAllocationAction = readAction({
  name: "VAULTBAGS_GET_TODAYS_ALLOCATION",
  similes: ["vaultbags allocation today", "what is the vault buying", "today's rwa split", "vault buy proportions"],
  description:
    "Today's RWA buy proportions (gold / S&P 500 / US treasuries), the 23-43% band, whether the decision is frozen for the day, the plain-English rationale, and the on-chain receipt transaction if already stamped.",
  schema: noInput,
  example: {
    output: { mode: "dynamic", frozen: true, weights: { gold: 33, spyx: 33, usdy: 33 }, band: { min: 23, max: 43 } },
    explanation: "Read the allocation VaultBags froze for today.",
  },
  run: (agent) => methods.getTodaysAllocation(agent),
});

const dailyBriefingAction = readAction({
  name: "VAULTBAGS_GET_DAILY_BRIEFING",
  similes: ["vaultbags briefing", "daily vault briefing", "why is the vault buying this"],
  description:
    "Today's public Daily Vault Briefing: a short market note explaining why the vault is buying in today's proportions, plus the weights and the on-chain receipt transaction.",
  schema: noInput,
  example: {
    output: { available: true, weights: { gold: 33, spyx: 33, usdy: 33 }, briefing: "..." },
    explanation: "Read today's market briefing behind the allocation.",
  },
  run: (agent) => methods.getDailyBriefing(agent),
});

const treasuryStatsAction = readAction({
  name: "VAULTBAGS_GET_TREASURY_STATS",
  similes: ["vaultbags treasury stats", "vault total value", "how much has the vault paid holders"],
  description:
    "Live treasury statistics: per-asset balances and USD values (gold, S&P 500, US treasuries), total vault value, total paid to holders, holder count, cycles processed and fees processed.",
  schema: noInput,
  example: {
    output: { totalValueUsd: 1234.56, holdersCount: 110, totalPaidToHoldersUsd: 420.69 },
    explanation: "Read the live treasury size and totals paid to holders.",
  },
  run: (agent) => methods.getTreasuryStats(agent),
});

const decisionHistoryAction = readAction({
  name: "VAULTBAGS_GET_DECISION_HISTORY",
  similes: ["vaultbags decision history", "past allocations", "recent vault decisions"],
  description:
    "Recent daily allocation decisions, newest first: date, weights, rationale and the on-chain receipt transaction of each day that was stamped.",
  schema: z.object({
    days: z.number().int().min(1).max(30).optional().describe("How many recent days to return (default 14, max 30)."),
  }),
  example: {
    input: { days: 7 },
    output: { days: 7, decisions: [{ date: "2026-07-04", weights: { gold: 33, spyx: 33, usdy: 33 } }] },
    explanation: "Read the last 7 daily decisions with their receipts.",
  },
  run: (agent, input) => methods.getDecisionHistory(agent, input),
});

const marketSignalsAction = readAction({
  name: "VAULTBAGS_GET_MARKET_SIGNALS",
  similes: ["vaultbags market signals", "signals behind the allocation", "vault macro reads"],
  description:
    "The quantitative market signals behind today's allocation: real yields, breakeven inflation, the dollar trend, gold momentum, credit spreads, volatility (VIX), S&P momentum, the 10Y yield, the 10Y-2Y curve and crypto sentiment. Each comes with its per-asset read (bullish / bearish / neutral relative to gold, the S&P 500 or US treasuries), plus the resulting convictions and weights. Numbers only; no free text influences them.",
  schema: noInput,
  example: {
    output: { available: true, signals: { realYield: 2.1, vix: 16 }, weights: { gold: 33, spyx: 33, usdy: 33 } },
    explanation: "Read the numeric signals that produced today's tilt.",
  },
  run: (agent) => methods.getMarketSignals(agent),
});

const brainVsFlatAction = readAction({
  name: "VAULTBAGS_GET_BRAIN_VS_FLAT",
  similes: ["vaultbags brain vs flat", "did the vault beat an even split", "allocation track record"],
  description:
    "The honest track record: did following the vault's daily Smart Allocation line beat a fixed even 33/33/33 split? Returns the cumulative return of each, the edge between them (positive means the daily line won, negative means it lagged, reported either way), how many days have been measured, and whether there is yet enough history for a headline verdict. Derived from the vault's own asset snapshots.",
  schema: noInput,
  example: {
    output: { available: true, brainReturn: 1.2, flatReturn: 0.8, edge: 0.4, daysMeasured: 30 },
    explanation: "Compare the daily allocation line against an even split.",
  },
  run: (agent) => methods.getBrainVsFlat(agent),
});

const simulateAllocationAction = readAction({
  name: "VAULTBAGS_SIMULATE_ALLOCATION",
  similes: ["vaultbags simulate allocation", "run the vault model", "what would the vault buy if"],
  description:
    "Run the vault's allocation model on YOUR market inputs and get back the buy proportions it would choose (gold / S&P 500 / US treasuries), the per-asset convictions, and a plain-English rationale, always within the 23-43% band. All inputs are optional numbers; provide any subset and the rest are treated as neutral. Deterministic and bounded: the same inputs always give the same weights. Not advice.",
  schema: z.object({
    realYield: z.number().optional().describe("10-year real (TIPS) yield, percent (e.g. 2.1)."),
    breakevenInfl: z.number().optional().describe("10-year breakeven inflation, percent."),
    dxyChangePct: z.number().optional().describe("Broad US dollar index percent change over ~1 month."),
    goldMomentumPct: z.number().optional().describe("Gold price percent change (recent trend)."),
    hyOas: z.number().optional().describe("US High Yield credit spread (OAS), percent."),
    vix: z.number().optional().describe("CBOE volatility index (VIX) level."),
    spx30dPct: z.number().optional().describe("S&P 500 percent change over ~1 month."),
    tenYear: z.number().optional().describe("10-year Treasury nominal yield, percent."),
    curve10y2y: z.number().optional().describe("10-year minus 2-year Treasury spread, percent."),
    fearGreed: z.number().optional().describe("Crypto Fear & Greed index, 0 to 100."),
  }),
  example: {
    input: { realYield: 2.5, vix: 28, hyOas: 6 },
    output: { weights: { gold: 38, spyx: 29, usdy: 33 }, band: { min: 23, max: 43 } },
    explanation: "Run the model on a risk-off scenario and see the tilt.",
  },
  run: (agent, input) => methods.simulateAllocation(agent, input),
});

const projectsAction = readAction({
  name: "VAULTBAGS_GET_PROJECTS",
  similes: ["vaultbags projects", "treasuries on vaultbags", "which tokens use vaultbags"],
  description:
    "Every treasury currently running on VaultBags (any Bags token can integrate, not just $VAULT). Returns each project's token mint, ticker, name, distribution split and total real-world-asset value.",
  schema: noInput,
  example: {
    output: { count: 1, projects: [{ ticker: "VAULT", distribution: "70/20/10" }] },
    explanation: "List every treasury live on VaultBags.",
  },
  run: (agent) => methods.getProjects(agent),
});

const projectTreasuryAction = readAction({
  name: "VAULTBAGS_GET_PROJECT_TREASURY",
  similes: ["vaultbags project treasury", "treasury for this token", "claim pool for a mint"],
  description:
    "One integrated project's live treasury by SPL token mint: the claimable pool and lock-boost pool real-world-asset holdings and USD values, the distribution split, and total fees processed. Read-only public on-chain data.",
  schema: z.object({
    mint: z.string().min(32).max(44).describe("The project's SPL token mint address (base58)."),
  }),
  example: {
    input: { mint: "So11111111111111111111111111111111111111112" },
    output: { found: true, ticker: "VAULT", totalValueUsd: 1234.56 },
    explanation: "Read one project's treasury by its token mint.",
  },
  run: (agent, input) => methods.getProjectTreasury(agent, input),
});

const vaultDocsAction = readAction({
  name: "VAULTBAGS_GET_VAULT_DOCS",
  similes: ["vaultbags docs", "how does vaultbags work", "explain the vault"],
  description:
    "Condensed protocol documentation: how the vault works, the 70/20/10 distribution, Smart Allocation, locking, claiming, and links to the live surfaces.",
  schema: noInput,
  example: {
    output: { protocol: "VaultBags: autonomous RWA treasury for Bags (Solana)..." },
    explanation: "Read a condensed explanation of the protocol.",
  },
  run: (agent) => methods.getVaultDocs(agent),
});

const listRwasAction = readAction({
  name: "VAULTBAGS_LIST_RWAS",
  similes: ["list solana rwas", "certified tokenized stocks", "which rwas exist on solana", "tokenized gold treasuries equities"],
  description:
    "A curated, on-chain-certified registry of openly transferable tokenized real-world assets on Solana (tokenized gold, US Treasuries, and US equities/ETFs from issuers like Backed/xStocks, Ondo and oro). Each entry's mint is proven authentic against the issuer's own domain, so it is safe to reference. Optionally filter by category or issuer. Read-only reference data; not advice, and not limited to what the vault itself holds.",
  schema: z.object({
    category: z.enum(["gold", "treasury", "equity-index", "equity"]).optional().describe("Filter by asset category."),
    issuer: z.enum(["backed", "ondo", "oro"]).optional().describe("Filter by issuer id."),
  }),
  example: {
    input: { category: "equity" },
    output: { count: 47, assets: [{ symbol: "AAPLx", category: "equity" }] },
    explanation: "List certified tokenized equities on Solana.",
  },
  run: (agent, input) => methods.listRwas(agent, input),
});

const getRwaAction = readAction({
  name: "VAULTBAGS_GET_RWA",
  similes: ["resolve rwa mint", "is this mint the real tokenized stock", "look up tokenized nvidia", "verify rwa token"],
  description:
    "Look up one tokenized real-world asset by its symbol (e.g. AAPLx, NVDAx, USDY, GOLD) or exact Solana mint, and get BOTH its certified identity (mint, decimals, underlying, issuer, how the address was verified) AND its live market read (on-chain price, 24h change, market cap, liquidity). Use it to resolve the real mint safely and to reason about an RWA's current behaviour.",
  schema: z.object({
    query: z.string().min(1).max(64).describe("A token symbol (case-insensitive) or an exact Solana mint address."),
  }),
  example: {
    input: { query: "NVDAx" },
    output: { found: true, asset: { symbol: "NVDAx" }, market: { priceUsd: 190.2 } },
    explanation: "Resolve tokenized NVIDIA's certified mint and live price.",
  },
  run: (agent, input) => methods.getRwa(agent, input),
});

const protocolMeterAction = readAction({
  name: "VAULTBAGS_GET_PROTOCOL_METER",
  similes: ["vaultbags meter", "protocol live numbers", "vaultbags overview stats", "how is the protocol doing"],
  description:
    "The Meter: one consolidated snapshot of the protocol's live, receipt-backed numbers. Live treasury value per asset, lifetime pipeline throughput (fees processed, cycles executed, projects integrated, value paid to holders), the daily brain's on-chain decision receipts, the agent's own settled x402 earnings, and locked supply, each section carrying the URL where it can be verified.",
  schema: noInput,
  example: {
    output: { treasury: { totalValueUsd: 1234.56 }, decisions: { stampedOnChain: 9 } },
    explanation: "Read the protocol's consolidated live numbers.",
  },
  run: (agent) => methods.getProtocolMeter(agent),
});

const autonomyAction = readAction({
  name: "VAULTBAGS_GET_AUTONOMY",
  similes: ["vaultbags autonomy score", "how autonomous is the vault", "agent track record"],
  description:
    "The vault agent's Autonomy Score and the verifiable facts behind it: daily frozen decisions, on-chain receipts, distribution cycles, value paid to holders, firewall status and earned-income coverage. A low sub-score means a young track record, not a failure.",
  schema: noInput,
  example: {
    output: { score: 72, tier: "autonomous" },
    explanation: "Read the agent's Autonomy Score and its evidence.",
  },
  run: (agent) => methods.getAutonomy(agent),
});

const agentPassportAction = readAction({
  name: "VAULTBAGS_GET_AGENT_PASSPORT",
  similes: ["vaultbags passport", "agent identity", "evaluate the vault agent"],
  description:
    "The vault agent's portable machine-readable passport: identity, capabilities, machine surfaces (MCP/REST/OpenAPI), Autonomy Score, and pointers to its on-chain decision receipts. Shaped so another agent can evaluate this one programmatically.",
  schema: noInput,
  example: {
    output: { identity: { name: "VaultBags Vault Agent" } },
    explanation: "Read the agent's machine-readable passport.",
  },
  run: (agent) => methods.getAgentPassport(agent),
});

const rwaPerformanceAction = readAction({
  name: "VAULTBAGS_GET_RWA_PERFORMANCE",
  similes: ["vault position performance", "vault cost basis", "how have the vault's buys done"],
  description:
    "The vault's REAL position performance per RWA (gold, S&P 500, US treasuries) since purchase: cost basis, average cost, current value and return, in both USD and SOL terms, reconstructed from actual on-chain swaps. Distinct from an asset's market price history: this is how the vault's own buys have done.",
  schema: noInput,
  example: {
    output: { totals: { returnUsdPct: 3.1 } },
    explanation: "Read the vault's own cost basis and returns per asset.",
  },
  run: (agent) => methods.getRwaPerformance(agent),
});

const shadowVsBrainAction = readAction({
  name: "VAULTBAGS_GET_SHADOW_VS_BRAIN",
  similes: ["shadow analyst scoreboard", "llm vs deterministic brain", "vaultbags shadow calls"],
  description:
    "The shadow analyst scoreboard: every day a language model makes its own allocation call from the same market signals as the deterministic brain, and this compares them honestly over time. The language model's calls never touch funds; this measures whether the deterministic approach holds up against it in public.",
  schema: noInput,
  example: {
    output: { available: true, nDays: 8 },
    explanation: "Compare the shadow language model's calls against the brain.",
  },
  run: (agent) => methods.getShadowVsBrain(agent),
});

const recentCyclesAction = readAction({
  name: "VAULTBAGS_GET_RECENT_CYCLES",
  similes: ["vaultbags recent cycles", "latest distributions", "protocol heartbeat"],
  description:
    "The latest distribution cycles across every integrated project: SOL processed, whether all swaps succeeded, and the on-chain distribution transaction receipt for each. The protocol's heartbeat, machine-readable.",
  schema: z.object({
    limit: z.number().int().min(1).max(20).optional().describe("How many recent cycles to return (default 5)."),
  }),
  example: {
    input: { limit: 5 },
    output: { cycles: [{ ticker: "$VAULT", solAmount: 0.42 }], totalCount: 300 },
    explanation: "Read the last distribution cycles with their receipts.",
  },
  run: (agent, input) => methods.getRecentCycles(agent, input),
});

const monthlyReportsAction = readAction({
  name: "VAULTBAGS_GET_MONTHLY_REPORTS",
  similes: ["vaultbags monthly reports", "closed books", "monthly close on-chain", "vault monthly report"],
  description:
    "The agent's closed books: one report per calendar month with fees claimed, cycles run, real-world assets distributed, value claimed by holders, decisions frozen and stamped, and its own settled earnings. Each month is committed on-chain via a Memo carrying the sha256 of the stored payload, so the numbers cannot be edited after the fact. A closed book reports the past and promises nothing.",
  schema: z.object({
    months: z.number().int().min(1).max(24).optional().describe("How many recent months to return (default 12)."),
  }),
  example: {
    input: { months: 3 },
    output: { reports: [{ period: "2026-06-01", receiptTx: "..." }] },
    explanation: "Read the last 3 monthly closed books with their on-chain receipts.",
  },
  run: (agent, input) => methods.getMonthlyReports(agent, input),
});

const proofOfReservesAction = readAction({
  name: "VAULTBAGS_GET_PROOF_OF_RESERVES",
  similes: ["vaultbags proof of reserves", "reserve wallets", "custody map", "on-chain reserves", "where are the reserves"],
  description:
    "Proof of Reserves: the named on-chain wallets that hold the vault's real-world assets, the certified issuer behind each asset (Backed/xStocks, Ondo, oro), live on-chain balances and USD values, plus the daily decision receipts and lifetime value paid to holders. Every wallet and balance is public and verifiable on Solscan. Read-only.",
  schema: noInput,
  example: {
    output: { totalReservesUsd: 565.0, reserves: [{ symbol: "GOLD", valueUsd: 188.3 }] },
    explanation: "Read the reserve wallets, issuers and live on-chain balances.",
  },
  run: (agent) => methods.getProofOfReserves(agent),
});

const verifyClaimAction = readAction({
  name: "VAULTBAGS_VERIFY_CLAIM",
  similes: ["verify vaultbags claim", "check a payout on-chain", "merkle proof for a claim", "was this claim honest"],
  description:
    "Verify one holder claim against the on-chain Merkle root. Given the claim's Solana transaction signature, returns the exact committed record (wallet, gold/S&P/treasury amounts, tx), its Merkle proof, the day's root, and the on-chain Memo that stamped that root. The guarantee is on-chain, not this response: recompute the leaf hash, fold the proof to a root, and check it against the memo. Proves the payout ledger is unaltered without trusting the operator.",
  schema: z.object({
    tx: z.string().min(43).max(90).describe("The claim's Solana transaction signature (base58)."),
  }),
  example: {
    input: { tx: "<claim transaction signature>" },
    output: { found: true, period: "2026-07-13", matchesOnChain: true },
    explanation: "Verify a holder claim against the day's on-chain Merkle root.",
  },
  run: (agent, input) => methods.verifyClaim(agent, input),
});

// The plugin object: name, methods (callable with full type safety via
// agent.methods.*), actions (LLM-callable), and a no-op initialize (the HTTP
// client is stateless and needs nothing from the agent to start).
const VaultBagsPlugin = {
  name: "vaultbags",
  methods: { ...methods },
  actions: [
    todaysAllocationAction,
    dailyBriefingAction,
    treasuryStatsAction,
    decisionHistoryAction,
    marketSignalsAction,
    brainVsFlatAction,
    simulateAllocationAction,
    projectsAction,
    projectTreasuryAction,
    vaultDocsAction,
    listRwasAction,
    getRwaAction,
    protocolMeterAction,
    autonomyAction,
    agentPassportAction,
    rwaPerformanceAction,
    shadowVsBrainAction,
    recentCyclesAction,
    monthlyReportsAction,
    proofOfReservesAction,
    verifyClaimAction,
  ],
  initialize() {},
};

export default VaultBagsPlugin;
export { methods };
