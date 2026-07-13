// Zero-dependency HTTP client for the VaultBags agent surface: the public,
// read-only REST mirror at /api/agent/* (the same data the MCP server serves).
// No SDK, no auth, no keys, native fetch only. The Solana Agent Kit plugin in
// index.js wraps these functions; this file is kept import-free so it can be
// unit-tested under plain node without the framework or zod present.
//
// Contract mirrored verbatim from the VaultBags source of truth
// (lib/data/agentTools AGENT_TOOLS + lib/mcpCore TOOLS): every capability is a
// GET to /api/agent/{restPath} with any arguments passed as query params, and
// a JSON body back. Read-only, idempotent, cacheable. Unknown query keys are
// rejected server-side, so each method sends only the parameters its tool
// actually declares.

export const DEFAULT_BASE_URL = "https://vaultbags.app";

// The ten signal inputs simulate_allocation accepts, all optional numbers. Any
// other key is rejected by the server, so we allowlist here too.
const SIMULATE_SIGNALS = [
  "realYield",
  "breakevenInfl",
  "dxyChangePct",
  "goldMomentumPct",
  "hyOas",
  "vix",
  "spx30dPct",
  "tenYear",
  "curve10y2y",
  "fearGreed",
];

// Resolve the base URL: an explicit override wins (passed straight in, or via
// the agent's config under OTHER_API_KEYS.VAULTBAGS_API_URL, the channel Solana
// Agent Kit exposes for third-party settings), otherwise production. Trailing
// slashes are trimmed so path joining stays clean.
export function resolveBaseUrl(agentOrUrl) {
  let url = DEFAULT_BASE_URL;
  if (typeof agentOrUrl === "string" && agentOrUrl.trim()) {
    url = agentOrUrl.trim();
  } else if (agentOrUrl && typeof agentOrUrl === "object") {
    const fromConfig = agentOrUrl?.config?.OTHER_API_KEYS?.VAULTBAGS_API_URL;
    if (typeof fromConfig === "string" && fromConfig.trim()) url = fromConfig.trim();
  }
  return url.replace(/\/+$/, "");
}

// Build a query string from a params object, skipping empty values so we never
// send an argument the caller did not actually provide.
function queryString(params) {
  if (!params) return "";
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    usp.append(key, String(value));
  }
  const s = usp.toString();
  return s ? `?${s}` : "";
}

async function callTool(agent, restPath, params) {
  const base = resolveBaseUrl(agent);
  const url = `${base}/api/agent/${restPath}${queryString(params)}`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
  } catch (err) {
    throw new Error(`VaultBags ${restPath}: network error (${err?.message || err})`);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`VaultBags ${restPath}: non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok) {
    const detail = json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new Error(`VaultBags ${restPath}: ${detail}`);
  }
  return json;
}

// Keep only the declared numeric signals that are finite, so simulate never
// forwards an unknown or non-numeric field.
function pickSignals(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  for (const key of SIMULATE_SIGNALS) {
    const v = input[key];
    if (v === undefined || v === null || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[key] = n;
  }
  return out;
}

// ---- The ten read-only capabilities -----------------------------------------
// Signature is (agent, input) to match Solana Agent Kit's method convention;
// `agent` is only read for an optional base-URL override, so both are optional
// and the functions work standalone too.

export function getTodaysAllocation(agent) {
  return callTool(agent, "todays-allocation");
}

export function getDailyBriefing(agent) {
  return callTool(agent, "daily-briefing");
}

export function getTreasuryStats(agent) {
  return callTool(agent, "treasury-stats");
}

export function getDecisionHistory(agent, input) {
  const days = input?.days;
  return callTool(agent, "decision-history", days === undefined ? undefined : { days });
}

export function getMarketSignals(agent) {
  return callTool(agent, "market-signals");
}

export function getBrainVsFlat(agent) {
  return callTool(agent, "brain-vs-flat");
}

export function simulateAllocation(agent, input) {
  return callTool(agent, "simulate", pickSignals(input));
}

export function getProjects(agent) {
  return callTool(agent, "projects");
}

export function getProjectTreasury(agent, input) {
  const mint = typeof input?.mint === "string" ? input.mint.trim() : "";
  return callTool(agent, "project-treasury", { mint });
}

export function getVaultDocs(agent) {
  return callTool(agent, "vault-docs");
}

export function listRwas(agent, input) {
  const params = {};
  if (typeof input?.category === "string" && input.category.trim()) params.category = input.category.trim();
  if (typeof input?.issuer === "string" && input.issuer.trim()) params.issuer = input.issuer.trim();
  return callTool(agent, "rwas", params);
}

export function getRwa(agent, input) {
  const query = typeof input?.query === "string" ? input.query.trim() : "";
  return callTool(agent, "rwa", { query });
}

export function getProtocolMeter(agent) {
  return callTool(agent, "protocol-meter");
}

export function getAutonomy(agent) {
  return callTool(agent, "autonomy");
}

export function getAgentPassport(agent) {
  return callTool(agent, "passport");
}

export function getRwaPerformance(agent) {
  return callTool(agent, "rwa-performance");
}

export function getShadowVsBrain(agent) {
  return callTool(agent, "shadow-vs-brain");
}

export function getRecentCycles(agent, input) {
  const limit = input?.limit;
  return callTool(agent, "recent-cycles", limit === undefined ? undefined : { limit });
}

export function getMonthlyReports(agent, input) {
  const months = input?.months;
  return callTool(agent, "monthly-reports", months === undefined ? undefined : { months });
}

export function getProofOfReserves(agent) {
  return callTool(agent, "proof-of-reserves");
}

export function verifyClaim(agent, input) {
  const tx = typeof input?.tx === "string" ? input.tx.trim() : "";
  return callTool(agent, "verify-claim", { tx });
}

// Named map for the plugin's `methods` object and for tests.
export const methods = {
  getTodaysAllocation,
  getDailyBriefing,
  getTreasuryStats,
  getDecisionHistory,
  getMarketSignals,
  getBrainVsFlat,
  simulateAllocation,
  getProjects,
  getProjectTreasury,
  getVaultDocs,
  listRwas,
  getRwa,
  getProtocolMeter,
  getAutonomy,
  getAgentPassport,
  getRwaPerformance,
  getShadowVsBrain,
  getRecentCycles,
  getMonthlyReports,
  getProofOfReserves,
  verifyClaim,
};
