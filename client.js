// Zero-dependency HTTP client for the VaultBags agent surface: the public,
// read-only REST mirror at /api/agent/* (the same data the MCP server serves).
// No SDK, no auth, no keys, native fetch only. The Solana Agent Kit plugin in
// index.js wraps these functions; this file imports nothing but a local module
// and node's own crypto, so it can be unit-tested under plain node without the
// framework or zod present.
//
// Contract mirrored verbatim from the VaultBags source of truth
// (lib/data/agentTools AGENT_TOOLS + lib/mcpCore TOOLS): every capability is a
// GET to /api/agent/{restPath} with any arguments passed as query params, and
// a JSON body back. Read-only, idempotent, cacheable. Unknown query keys are
// rejected server-side, so each method sends only the parameters its tool
// actually declares.

import {
  decodeReceipt,
  verifyReceiptSignature,
  checkReceiptClaims,
  paymentFieldsUsable,
  isoFromSeconds,
  compareDelivery,
  RECEIPT_ALG,
} from "./receipt.js";

export const DEFAULT_BASE_URL = "https://vaultbags.app";

// The public explorer a caller is pointed at to read a transaction themselves.
// Named once rather than built inline wherever a link is needed.
const SOLSCAN_URL = "https://solscan.io";

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

// How long to wait for an answer before giving up.
//
// fetch has no timeout of its own, anywhere. A request that is accepted and
// then never answered leaves its promise unsettled for ever, and an agent
// awaiting one of these calls simply stops: no error to report, no branch to
// take, nothing to retry. A bounded failure is something a caller can handle;
// an unbounded wait is not.
//
// Fifteen seconds is long enough for a slow answer on a congested route and
// short enough that a dead one becomes a real error while the caller is still
// there. Overridable for callers on unusual links.
export const DEFAULT_TIMEOUT_MS = 15_000;

export function resolveTimeoutMs(agentOrUrl) {
  const raw = agentOrUrl && typeof agentOrUrl === "object"
    ? agentOrUrl?.config?.OTHER_API_KEYS?.VAULTBAGS_TIMEOUT_MS
    : undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// One JSON request, carrying the timeout and the error wording every capability
// shares. `label` is how a failure is named, and `acceptStatuses` lists the
// non-2xx codes that are a legitimate ANSWER rather than a failure: a paid
// resource describes its terms in a 402, which is not an error to report.
async function requestJson(agent, path, { label, acceptStatuses = [] } = {}) {
  const base = resolveBaseUrl(agent);
  const url = `${base}${path}`;
  const timeoutMs = resolveTimeoutMs(agent);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // The timeout covers the whole answer, body included. It used to be cleared
  // as soon as the headers arrived, so a server that sent them and then
  // trickled or stalled the body held the call for as long as it liked.
  let res;
  let text;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal: controller.signal });
    text = await res.text();
  } catch (err) {
    // "AbortError" tells a caller nothing it can act on. Say what happened.
    if (err?.name === "AbortError" || controller.signal.aborted) {
      throw new Error(`VaultBags ${label}: no answer within ${timeoutMs}ms`);
    }
    throw new Error(`VaultBags ${label}: network error (${err?.message || err})`);
  } finally {
    clearTimeout(timer);
  }
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`VaultBags ${label}: non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok && !acceptStatuses.includes(res.status)) {
    const detail = json && typeof json.error === "string" ? json.error : `HTTP ${res.status}`;
    throw new Error(`VaultBags ${label}: ${detail}`);
  }
  return { status: res.status, json };
}

async function callTool(agent, restPath, params) {
  const { json } = await requestJson(agent, `/api/agent/${restPath}${queryString(params)}`, { label: restPath });
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

// ---- The read-only capabilities ---------------------------------------------
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

export function getAgent(agent, input) {
  const mint = typeof input?.mint === "string" ? input.mint.trim() : "";
  return callTool(agent, "evaluate", { mint });
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

export function getAutonomySpec(agent) {
  return callTool(agent, "autonomy-spec");
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

export function getPayoutIntegrity(agent) {
  return callTool(agent, "payout-integrity");
}

export function getLockTier(agent, input) {
  const args = {};
  if (input?.days !== undefined) args.days = input.days;
  if (input?.wallet !== undefined) args.wallet = input.wallet;
  return callTool(agent, "lock-tier", Object.keys(args).length ? args : undefined);
}

export function getTreasuryHistory(agent, input) {
  const args = {};
  if (input?.days !== undefined) args.days = input.days;
  if (input?.points !== undefined) args.points = input.points;
  return callTool(agent, "treasury-history", Object.keys(args).length ? args : undefined);
}

export function getHolderDistribution(agent) {
  return callTool(agent, "holder-distribution");
}

export function getRecentActivity(agent) {
  return callTool(agent, "recent-activity");
}

export function getProofOfReserves(agent) {
  return callTool(agent, "proof-of-reserves");
}

export function verifyClaim(agent, input) {
  const tx = typeof input?.tx === "string" ? input.tx.trim() : "";
  return callTool(agent, "verify-claim", { tx });
}

export function simulateLockBoost(agent, { amount } = {}) {
  return callTool(agent, amount != null ? `lock-boost?amount=${encodeURIComponent(amount)}` : "lock-boost");
}

export function verifyDay(agent, { period } = {}) {
  return callTool(agent, period ? `verify-day?period=${encodeURIComponent(period)}` : "verify-day");
}

// Omitting the date asks for today's decision, which is what the endpoint
// defaults to, so an empty value is left off rather than sent as "".
export function verifyDecision(agent, input) {
  const date = typeof input?.date === "string" ? input.date.trim() : "";
  return callTool(agent, "verify-decision", date ? { date } : undefined);
}

export function getLiquidity(agent) {
  return callTool(agent, "liquidity");
}

export function getSupply(agent) {
  return callTool(agent, "supply");
}

export function getRaffle(agent) {
  return callTool(agent, "raffle");
}

export function getStrategies(agent) {
  return callTool(agent, "strategies");
}

export function getStrategy(agent, input) {
  const strategy = typeof input?.strategy === "string" ? input.strategy.trim() : "";
  return callTool(agent, "strategy", { strategy });
}

// ---- Verifying a payment receipt --------------------------------------------

// The wallet and asset the vault advertises for payment right now, read from
// the paid lane's own 402 terms. Best-effort by design: the lane can be off, or
// the base URL can point elsewhere, and neither is a reason to fail a
// verification that otherwise held. Returns null when it cannot be read.
async function readAdvertisedTerms(agent) {
  try {
    const { status, json } = await requestJson(agent, "/api/agent/ask", {
      label: "payment terms",
      acceptStatuses: [402],
    });
    if (status !== 402 || !Array.isArray(json?.accepts) || !json.accepts.length) return null;
    const payTo = [...new Set(json.accepts.map((a) => a?.payTo).filter((v) => typeof v === "string"))];
    const asset = [...new Set(json.accepts.map((a) => a?.asset).filter((v) => typeof v === "string"))];
    return payTo.length && asset.length ? { payTo, asset } : null;
  } catch {
    return null;
  }
}

// Verify a receipt taken from the `X-X402-Receipt` header of a paid call.
//
// Three legs, kept apart in the response: the SIGNATURE against the key the
// issuer publishes (which proves who issued the receipt), the CLAIMS against
// their own rules, and the DESTINATION against what the vault advertises for
// payment right now. The payment itself is proven by the transaction on Solana,
// which this package deliberately does not read: it speaks only to the public
// HTTPS surface. So it returns the transaction and says plainly where the proof
// lives, rather than implying a settlement it never checked.
//
// A fourth leg, local and optional: what the receipt says the payment BOUGHT,
// against the answer (and question) or export the caller holds.
export async function verifyReceipt(agent, input) {
  const receipt = typeof input?.receipt === "string" ? input.receipt.trim() : "";
  const decoded = decodeReceipt(receipt);
  if (!decoded.ok) {
    return {
      signatureValid: false,
      issuedByVaultBags: false,
      // Stated on every answer: a receipt nothing could be checked against is
      // not a live proof of anything.
      current: false,
      paymentProvenHere: false,
      reason: decoded.reason,
      summary: `Not a readable receipt: ${decoded.reason}.`,
    };
  }

  const { json: jwks } = await requestJson(agent, "/.well-known/jwks.json", { label: "receipt keys" });
  const keys = Array.isArray(jwks?.keys) ? jwks.keys : [];
  if (!keys.length) {
    return {
      signatureValid: false,
      issuedByVaultBags: false,
      // Stated on every answer: a receipt nothing could be checked against is
      // not a live proof of anything.
      current: false,
      paymentProvenHere: false,
      reason: "no signing key is published right now, so no receipt can be checked against one",
      summary:
        "No signing key is published, so this receipt cannot be checked here. The transaction it names can still be read on Solana.",
    };
  }

  const signature = verifyReceiptSignature(decoded, keys);
  if (!signature.ok) {
    return {
      signatureValid: false,
      issuedByVaultBags: false,
      // Stated on every answer: a receipt nothing could be checked against is
      // not a live proof of anything.
      current: false,
      paymentProvenHere: false,
      reason: signature.reason,
      summary: `This receipt was not signed by VaultBags: ${signature.reason}.`,
    };
  }

  const claims = decoded.claims;
  const checks = checkReceiptClaims(claims);
  const claimsValid = checks.every((c) => c.pass);
  // Every claim but the time box holds: the receipt is genuine and has lapsed.
  const lapsed = !claimsValid && checks.every((c) => c.pass || c.expired);

  const terms = await readAdvertisedTerms(agent);
  const destination = terms
    ? {
        compared: true,
        matches: terms.payTo.includes(claims.pay_to) && terms.asset.includes(claims.asset),
        advertisedPayTo: terms.payTo,
        advertisedAsset: terms.asset,
      }
    : {
        compared: false,
        reason: "the paid lane did not answer with its terms, so the destination was read from the receipt alone",
      };

  const failed = checks.filter((c) => !c.pass).map((c) => c.name);
  const usable = paymentFieldsUsable(claims);
  // Passed through as given: compareDelivery says why a value of the wrong
  // type was not compared, rather than this dropping it in silence.
  const delivery = compareDelivery(claims, { answer: input?.answer, question: input?.question, content: input?.content });
  const comparisons = [delivery.answerMatches, delivery.questionMatches, delivery.contentMatches].filter((v) => v !== null && v !== undefined);
  // True only when something was compared and all of it matched; false when
  // anything differed; null when nothing could be compared. Whether everything
  // that CAN be compared was is deliveryFullyChecked: an answer matched without
  // its question shows which answer was delivered, not what it answered.
  const deliveryMatches = comparisons.length ? comparisons.every(Boolean) : null;
  const notCompared = Array.isArray(delivery.notCompared) && delivery.notCompared.length ? ` Not compared: ${delivery.notCompared.join("; ")}.` : "";
  const tools =
    delivery.kind !== "answer"
      ? ""
      : delivery.toolsRead.length
        ? `${delivery.toolsRead.join(", ")}${delivery.toolsListComplete ? "" : " (the list is incomplete: at least one read could not be named)"}`
        : delivery.toolsListComplete
          ? "no tool"
          : "tools this receipt could not name";
  // One sentence per thing that was compared, each naming what it was: a
  // question that matched says nothing about the answer, and the reverse.
  const part = (matches, yes, no) => (matches === true ? ` ${yes}` : matches === false ? ` ${no}` : "");
  const deliverySentence = !delivery.named
    ? delivery.malformed
      ? " Its delivery field is malformed, so what it says the payment bought cannot be read."
      : delivery.newer
        ? " What it says the payment bought is written in a format newer than this plugin reads; update the plugin to check it."
        : ""
    : delivery.kind === "answer"
      ? ` It names what the payment bought: an answer, after reading ${tools}.${part(delivery.answerMatches, "The answer you hold is the one it delivered.", "The answer you hold is NOT the one it delivered.")}${part(delivery.questionMatches, "The question you hold is the one it answered.", "The question you hold is NOT the one it answered.")}${notCompared}`
      : ` It names what the payment bought: an export with canonical sha256 ${delivery.contentSha256}.${part(delivery.contentMatches, "The export you hold is the one it delivered.", "The export you hold is NOT the one it delivered.")}${notCompared}`;
  // The command that checks the same receipt from a terminal, with the files
  // this receipt's kind of delivery can be checked against. Pinned: an older
  // cached copy would ignore the delivery options. A format newer than this
  // plugin reads needs the newest verifier, whatever that is by then.
  const checkCommand = delivery.newer
    ? "npx vaultbags-cli@latest verify receipt <receipt>"
    : !delivery.named
      ? "npx vaultbags-cli@0.7.0 verify receipt <receipt>"
      : delivery.kind === "answer"
        ? "npx vaultbags-cli@0.7.0 verify receipt <receipt> --body=response.json --question=question.txt"
        : "npx vaultbags-cli@0.7.0 verify receipt <receipt> --body=response.json";

  return {
    // What this response does establish.
    signatureValid: true,
    signedWithKey: signature.kid,
    algorithm: RECEIPT_ALG,
    claimsValid,
    checks,
    destination,
    // Whether the receipt is inside its time box. A receipt is issued for an
    // hour; after that it is still genuine but no longer a live proof, so a
    // caller that accepts receipts as proof of a fresh payment must require
    // this, not only issuedByVaultBags.
    current: checks.some((c) => c.name === "not expired" && c.pass),
    // Whether VaultBags issued this receipt as it reads: true only when nothing
    // that COULD be checked came back wrong, apart from the time box. A
    // comparison that could not run counts as neither a pass nor a failure.
    issuedByVaultBags: (claimsValid || lapsed) && destination.matches !== false,

    // What the receipt says, verbatim.
    payment: {
      transaction: claims.tx_hash,
      payer: claims.payer_wallet ?? null,
      amount: claims.amount,
      currency: claims.currency,
      paidTo: claims.pay_to,
      asset: claims.asset,
      resource: claims.resource,
      network: claims.network,
      receiptId: claims.jti,
      issuedAt: isoFromSeconds(claims.iat),
      expiresAt: isoFromSeconds(claims.exp),
    },

    // What the payment bought, as the receipt names it, and whether what the
    // caller passed in is that (null when nothing was passed to compare).
    // A caller treating the text it holds as the one paid for requires both
    // deliveryMatches === true and deliveryFullyChecked === true.
    delivery,
    deliveryMatches,
    deliveryFullyChecked: delivery.fullyChecked === true,

    // What it does NOT establish, said rather than left to be assumed.
    paymentProvenHere: false,
    // Built only from fields that passed validation. A receipt naming no
    // well-formed transaction gets no lookup: assembling a link out of a value
    // this same response just rejected would point a reader at something that
    // is not what the link claims to be.
    proveThePaymentYourself: usable
      ? {
          how: `Read transaction ${claims.tx_hash} on Solana: it must have succeeded, and moved at least ${claims.amount} atomic units of ${claims.asset} to ${claims.pay_to}${claims.payer_wallet ? `, signed by ${claims.payer_wallet}` : ""}.`,
          explorer: `${SOLSCAN_URL}/tx/${encodeURIComponent(claims.tx_hash)}`,
          command: checkCommand,
        }
      : {
          how: "This receipt does not name a well-formed transaction, so there is nothing to look up on Solana.",
          explorer: null,
          command: null,
        },
    summary: claimsValid || lapsed
      ? `Signed by VaultBags${destination.compared && !destination.matches ? ", but it names a wallet the vault does not advertise for payment" : ""}.${lapsed ? ` It expired at ${isoFromSeconds(claims.exp) ?? "its stated expiry"}: receipts are time-boxed, so it is genuine but no longer a live proof.` : ""} It says ${claims.amount} atomic units of ${claims.currency} were paid for ${claims.resource} in transaction ${claims.tx_hash}.${deliverySentence} The signature proves who issued the receipt; the transaction on Solana is what proves the payment.`
      : `Signed by VaultBags, but its own claims do not hold: ${failed.join("; ")}.`,
  };
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
  getAgent,
  getVaultDocs,
  listRwas,
  getRwa,
  getProtocolMeter,
  getAutonomy,
  getAutonomySpec,
  getAgentPassport,
  getRwaPerformance,
  getShadowVsBrain,
  getRecentCycles,
  getMonthlyReports,
  getProofOfReserves,
  getPayoutIntegrity,
  getLockTier,
  getTreasuryHistory,
  getHolderDistribution,
  getRecentActivity,
  verifyClaim,
  simulateLockBoost,
  verifyDay,
  verifyDecision,
  getLiquidity,
  getSupply,
  getRaffle,
  getStrategies,
  getStrategy,
  verifyReceipt,
};
