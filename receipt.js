// Verifying a VaultBags payment receipt, locally.
//
// A response the paid lane settles on-chain carries an `X-X402-Receipt` header:
// a short RS256 JWT naming the transaction, the payer, the amount, the wallet
// paid, the asset and the resource bought. This file checks one, using only
// node:crypto, so an agent that paid can confirm what it holds without asking
// anyone, this package included.
//
// What a passing signature proves and what it does not:
//   - it proves vaultbags.app ISSUED the receipt and that not one byte changed
//   - it does NOT prove the payment happened; the transaction on Solana does
// The two are kept apart everywhere below, because a verifier that blurs them
// would report a settled payment on the strength of a signature alone.
//
// Every decision is made from the bytes, never from what the token says about
// itself. The one thing the token may influence is WHICH published key is
// tried (its kid), and only among keys the issuer publishes. The algorithm is
// pinned before any key is touched, which closes the two classic JWT holes:
// "alg":"none" (a token with no signature at all) and HS256 with the public
// key used as the secret.
//
// This logic also exists in the vaultbags-cli package. Neither may depend on
// the other (this one installs nothing; that one is a command), so the rules
// live twice on purpose and are pinned by tests in both.

import { createPublicKey, createHash, verify as cryptoVerify } from "node:crypto";

export const RECEIPT_ISSUER = "vaultbags.app";
export const RECEIPT_AUDIENCE = "vaultbags:x402-receipt";
export const RECEIPT_ALG = "RS256";

// A real receipt is a few hundred bytes. Anything an order of magnitude larger
// is not one, and decoding it would be work done on someone else's behalf.
export const MAX_RECEIPT_BYTES = 8192;

// Three base64url parts joined by dots. Used to reject a wrong paste before any
// parsing: no secret is shaped like this, so something handed to this tool by
// mistake never reaches the decoder.
export const RECEIPT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// RSA below this is not considered safe to sign with. A key that size is
// refused even when the issuer publishes it: a verifier that accepts a weak key
// because it was published has handed its judgement back to the signer.
const MIN_MODULUS_BITS = 2048;

// Clock skew allowed before a receipt reads as issued in the future.
const IAT_TOLERANCE_SEC = 300;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isSignature = (s) => typeof s === "string" && s.length >= 64 && s.length <= 88 && BASE58.test(s);
const isAddress = (s) => typeof s === "string" && s.length >= 32 && s.length <= 44 && BASE58.test(s);

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

// Split and decode, nothing more. A receipt that fails here was never a
// receipt; one that passes has said nothing yet about who signed it.
export function decodeReceipt(jwt) {
  if (typeof jwt !== "string" || !jwt) return { ok: false, reason: "no receipt given" };
  if (Buffer.byteLength(jwt, "utf8") > MAX_RECEIPT_BYTES) {
    return { ok: false, reason: `longer than any receipt (${MAX_RECEIPT_BYTES} bytes)` };
  }
  if (!RECEIPT_SHAPE.test(jwt)) {
    return { ok: false, reason: "a receipt is three base64url parts separated by dots" };
  }
  const [h, p, s] = jwt.split(".");
  const header = decodePart(h);
  const claims = decodePart(p);
  if (!isObject(header) || !isObject(claims)) {
    return { ok: false, reason: "header or claims are not a JSON object" };
  }
  return { ok: true, header, claims, signingInput: `${h}.${p}`, signature: Buffer.from(s, "base64url") };
}

// Check the signature against the issuer's published keys. Returns
// { ok: true, kid } or { ok: false, reason }. Only the RSA public parameters of
// the chosen key reach the crypto layer, so nothing else in a published key
// object can influence the result.
export function verifyReceiptSignature(decoded, keys) {
  const { header, signingInput, signature } = decoded;
  if (header.alg !== RECEIPT_ALG) {
    return { ok: false, reason: `alg is ${JSON.stringify(header.alg ?? null)}; only ${RECEIPT_ALG} is accepted` };
  }
  if (typeof header.kid !== "string" || !header.kid) {
    return { ok: false, reason: "the header names no key (kid)" };
  }
  const list = Array.isArray(keys) ? keys : [];
  const jwk = list.find((k) => isObject(k) && k.kid === header.kid);
  if (!jwk) return { ok: false, reason: `the issuer publishes no key with id ${header.kid}` };
  if (jwk.kty !== "RSA") return { ok: false, reason: "the published key is not RSA" };
  if (jwk.use !== undefined && jwk.use !== "sig") {
    return { ok: false, reason: "the published key is not for signatures" };
  }
  if (jwk.alg !== undefined && jwk.alg !== RECEIPT_ALG) {
    return { ok: false, reason: `the published key is for ${jwk.alg}, not ${RECEIPT_ALG}` };
  }
  let key;
  try {
    key = createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" });
  } catch {
    return { ok: false, reason: "the published key could not be parsed" };
  }
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0;
  if (bits < MIN_MODULUS_BITS) {
    return { ok: false, reason: `the published key is ${bits}-bit RSA; ${MIN_MODULUS_BITS} is the floor` };
  }
  let good = false;
  try {
    good = cryptoVerify("RSA-SHA256", Buffer.from(signingInput), key, signature);
  } catch {
    good = false;
  }
  return good ? { ok: true, kid: header.kid } : { ok: false, reason: "the signature does not verify against that key" };
}

// The claims, held to their own rules. Every entry is one line a reader sees,
// and all must pass before anything downstream treats the receipt as coherent.
export function checkReceiptClaims(claims, { nowSec = Math.floor(Date.now() / 1000) } = {}) {
  const out = [];
  const add = (name, pass, detail) => out.push({ name, pass, detail: detail || null });

  add(`issued by ${RECEIPT_ISSUER}`, claims.iss === RECEIPT_ISSUER, claims.iss === RECEIPT_ISSUER ? null : `iss is ${JSON.stringify(claims.iss ?? null)}`);
  add("addressed to receipt verifiers", claims.aud === RECEIPT_AUDIENCE, claims.aud === RECEIPT_AUDIENCE ? null : `aud is ${JSON.stringify(claims.aud ?? null)}`);
  add(
    "records a settled payment",
    claims.event === "payment.succeeded" && claims.status === "settled",
    `event ${JSON.stringify(claims.event ?? null)}, status ${JSON.stringify(claims.status ?? null)}`
  );

  const expOk = Number.isInteger(claims.exp) && nowSec <= claims.exp;
  add(
    "not expired",
    expOk,
    expOk
      ? null
      : Number.isInteger(claims.exp)
        ? `expired ${nowSec - claims.exp}s ago; a receipt is a time-boxed proof, the payment itself stays readable on-chain for ever`
        : "no expiry"
  );
  // Past its expiry is not the same as malformed: the receipt was still issued.
  // `expired` marks that one case so a caller can say "genuine, but lapsed"
  // instead of reading a lapsed time box as a receipt VaultBags did not issue.
  // A receipt with no expiry at all is malformed and gets no marker.
  if (!expOk && Number.isInteger(claims.exp)) out[out.length - 1].expired = true;
  const iatOk =
    Number.isInteger(claims.iat) &&
    claims.iat <= nowSec + IAT_TOLERANCE_SEC &&
    (!Number.isInteger(claims.exp) || claims.iat <= claims.exp);
  add("issued in the past", iatOk, iatOk ? null : "iat is missing, in the future, or after exp");

  const jtiOk = typeof claims.jti === "string" && claims.jti.length >= 8 && claims.jti.length <= 128;
  add("carries a unique id", jtiOk, jtiOk ? null : "jti is missing or malformed");

  add("names a transaction", isSignature(claims.tx_hash), isSignature(claims.tx_hash) ? null : "tx_hash is not a Solana signature");

  const amountOk = typeof claims.amount === "string" && /^\d{1,30}$/.test(claims.amount) && BigInt(claims.amount) > 0n;
  const currencyOk = claims.currency === "USDC";
  add(
    "names a positive amount in USDC",
    amountOk && currencyOk,
    amountOk && currencyOk ? null : `amount ${JSON.stringify(claims.amount ?? null)} ${JSON.stringify(claims.currency ?? null)}`
  );

  const destOk = isAddress(claims.pay_to) && isAddress(claims.asset);
  add("names the destination wallet and the asset", destOk, destOk ? null : "pay_to or asset is not a Solana address");

  const payerOk = claims.payer_wallet === null || claims.payer_wallet === undefined || isAddress(claims.payer_wallet);
  add(
    "names the payer, or says it could not",
    payerOk,
    payerOk ? (claims.payer_wallet ? null : "no payer recorded; a chain check then rests on the transfer alone") : "payer_wallet is not a Solana address"
  );

  // Against the constant, not against the token's own iss: a forged issuer must
  // not get to redefine whose resource counts as the issuer's.
  let resourceOk = false;
  try {
    const u = new URL(claims.resource);
    resourceOk = u.protocol === "https:" && u.host === RECEIPT_ISSUER;
  } catch {
    resourceOk = false;
  }
  add("names a resource of the issuer", resourceOk, resourceOk ? null : `resource is ${JSON.stringify(claims.resource ?? null)}`);

  const networkOk = typeof claims.network === "string" && claims.network.length > 0 && claims.network.length <= 64;
  add("names the network", networkOk, networkOk ? null : "network is missing");

  return out;
}

// Whether the four fields that identify the payment are well formed, so a
// caller can be told where to look it up. Kept separate from the full claim
// check because it answers a narrower question: not "is this receipt sound"
// but "is there a real transaction here to point someone at". A receipt that
// fails this must not have a lookup built from it, or the answer would hand
// over a link assembled from a field it just rejected.
export function paymentFieldsUsable(claims) {
  return (
    !!claims &&
    isSignature(claims.tx_hash) &&
    isAddress(claims.pay_to) &&
    isAddress(claims.asset) &&
    typeof claims.amount === "string" &&
    /^\d{1,30}$/.test(claims.amount)
  );
}

// An ISO timestamp from a JWT's seconds, or null when the value is outside the
// range a date can represent. `new Date(n).toISOString()` THROWS past roughly
// year 275760, and an integer that large passes every check above, so a receipt
// carrying one used to end in a RangeError where a verdict was already in hand.
const MAX_DATE_MS = 8.64e15;
export function isoFromSeconds(sec) {
  if (!Number.isInteger(sec)) return null;
  const ms = sec * 1000;
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return null;
  return new Date(ms).toISOString();
}

// --- What the payment bought ---------------------------------------------------
//
// A receipt can also name what the call delivered (`delivery`): for an answer,
// the sha256 of the question as the agent read it, of the answer exactly as
// served, and the tools whose results it read; for an export, the sha256 of the
// served JSON body, canonicalized. Signed with the payment, it lets whoever
// holds the text show it is what VaultBags delivered for that payment. It says
// nothing about whether the answer is right, and an answer compared without
// its question shows which answer was delivered, not what it was the answer
// to. Same rules, and the same pinned vectors, as vaultbags-cli:
//   question_sha256  sha256 of the question's UTF-8 bytes with the whitespace
//                    String.prototype.trim removes taken off both ends (a
//                    leading byte-order mark included)
//   answer_sha256    sha256 of the answer's UTF-8 bytes exactly as served
//   content_sha256   sha256 of the export's canonical JSON: keys sorted by
//                    UTF-16 code unit, arrays in order, no whitespace, strings
//                    and numbers as JSON.stringify writes them (for any JSON a
//                    response carries, RFC 8785's canonical form)
// The question hash is not salted: a receipt does not keep its question secret
// from someone who can guess it.

const HEX64 = /^[0-9a-f]{64}$/;
// The agent's analyst tools are camelCase (getMarketOverview), its public
// surface snake_case (get_market_signals).
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_DELIVERY_TOOLS = 16;
const DELIVERY_VERSION = 1;
const ANSWER_KEYS = new Set(["v", "kind", "question_sha256", "answer_sha256", "tools", "tools_incomplete"]);
const EXPORT_KEYS = new Set(["v", "kind", "content_sha256"]);
const sha256Utf8 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const withoutBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// Canonical JSON: keys sorted recursively, arrays in order, primitives via
// JSON.stringify, undefined skipped. Kept byte-identical to the issuer's.
export function canonicalStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => canonicalStringify(v)).join(",") + "]";
  }
  const parts = [];
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    parts.push(JSON.stringify(key) + ":" + canonicalStringify(value[key]));
  }
  return "{" + parts.join(",") + "}";
}

// "ok", "malformed", or "newer": a delivery in a version or kind this plugin
// does not know, or carrying fields it does not read. Newer is not a failure:
// VaultBags signed something this version cannot check, and the honest answer
// is "update and check again", never "forged".
export function deliveryShape(d) {
  if (!isObject(d)) return "malformed";
  if (Number.isInteger(d.v) && d.v > DELIVERY_VERSION) return "newer";
  if (d.v !== DELIVERY_VERSION) return "malformed";
  if (d.kind === "answer") {
    const known =
      HEX64.test(d.question_sha256 || "") &&
      HEX64.test(d.answer_sha256 || "") &&
      Array.isArray(d.tools) &&
      d.tools.length <= MAX_DELIVERY_TOOLS &&
      d.tools.every((t) => typeof t === "string" && TOOL_NAME.test(t)) &&
      new Set(d.tools).size === d.tools.length &&
      (d.tools_incomplete === undefined || d.tools_incomplete === true);
    if (!known) return "malformed";
    return Object.keys(d).every((k) => ANSWER_KEYS.has(k)) ? "ok" : "newer";
  }
  if (d.kind === "export") {
    if (!HEX64.test(d.content_sha256 || "")) return "malformed";
    return Object.keys(d).every((k) => EXPORT_KEYS.has(k)) ? "ok" : "newer";
  }
  return typeof d.kind === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(d.kind) ? "newer" : "malformed";
}

// The question as the agent hashed it; a question copied out of a Windows
// file may carry carriage returns it never had, so that spelling is tried too.
function questionMatches(question, expected) {
  const plain = withoutBom(question);
  if (sha256Utf8(plain.trim()) === expected) return true;
  const lf = plain.replace(/\r\n/g, "\n");
  return lf !== plain && sha256Utf8(lf.trim()) === expected;
}

// The export to compare: the parsed body, or its JSON text. Null with a reason
// when it is neither, so a value that could not be read is never reported as
// a body that differs.
function readContent(content) {
  let value = content;
  if (typeof content === "string") {
    try {
      value = JSON.parse(withoutBom(content));
    } catch {
      return { ok: false, reason: "content is a string that is not JSON; pass the export as received" };
    }
  }
  try {
    const canonical = canonicalStringify(JSON.parse(JSON.stringify(value)));
    if (typeof canonical !== "string") throw new Error("not serializable");
    return { ok: true, canonical };
  } catch {
    return { ok: false, reason: "content could not be read as JSON (a cycle, a BigInt, or not JSON at all)" };
  }
}

// Compare what the caller holds with what the receipt names. `answer` and
// `question` are strings; `content` is the export as parsed JSON or as its
// JSON text. Each comparison is true, false, or null when it could not be made
// (nothing given, a value of the wrong type, or the receipt is of the other
// kind), and every null that came from something the caller passed says why
// in `notCompared`. `fullyChecked` is true only when everything the receipt
// names that a caller can hold was compared and matched: for an answer, the
// answer AND the question; for an export, the export.
export function compareDelivery(claims, { answer, question, content } = {}) {
  const d = claims?.delivery;
  if (d === undefined) return { named: false, reason: "this receipt names the payment only, not what it delivered", fullyChecked: false };
  const shape = deliveryShape(d);
  if (shape === "newer") {
    return {
      named: false,
      newer: true,
      reason: "its delivery is written in a format newer than this plugin reads; update the plugin, or run npx vaultbags-cli@latest verify receipt <receipt>",
      fullyChecked: false,
    };
  }
  if (shape === "malformed") return { named: false, malformed: true, reason: "its delivery field is malformed", fullyChecked: false };

  const notCompared = [];
  const given = (value, label, type) => {
    if (value === undefined || value === null) return false;
    if (typeof value !== type) {
      notCompared.push(`${label} was not a ${type}`);
      return false;
    }
    return true;
  };

  if (d.kind === "answer") {
    if (content !== undefined && content !== null) notCompared.push("content was passed, but this receipt is for an answer: pass the answer text");
    const answerMatches = given(answer, "answer", "string") ? sha256Utf8(answer) === d.answer_sha256 : null;
    const qMatches = given(question, "question", "string") ? questionMatches(question, d.question_sha256) : null;
    if (answerMatches !== null && qMatches === null) {
      notCompared.push("the question was not passed: the answer shows which answer was delivered, not what it was the answer to");
    }
    return {
      named: true,
      kind: "answer",
      toolsRead: [...d.tools],
      toolsListComplete: d.tools_incomplete !== true,
      answerMatches,
      questionMatches: qMatches,
      contentMatches: null,
      notCompared,
      fullyChecked: answerMatches === true && qMatches === true,
    };
  }

  if ((answer !== undefined && answer !== null) || (question !== undefined && question !== null)) {
    notCompared.push("an answer or question was passed, but this receipt is for an export: pass the export as content");
  }
  let contentMatches = null;
  if (content !== undefined && content !== null) {
    const read = readContent(content);
    if (read.ok) contentMatches = sha256Utf8(read.canonical) === d.content_sha256;
    else notCompared.push(read.reason);
  }
  return {
    named: true,
    kind: "export",
    contentSha256: d.content_sha256,
    answerMatches: null,
    questionMatches: null,
    contentMatches,
    notCompared,
    fullyChecked: contentMatches === true,
  };
}
