// The receipt verifier, with keys generated here and never used again.
//
// Weighted towards what must be REFUSED. A verifier that lets one forged token
// through has told an agent a payment happened that did not, which is the one
// thing it exists to prevent. The chain leg is not tested because it is not
// performed: this package reports the transaction and says the proof lives
// there, and the last test in this file pins that it never claims otherwise.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, createHash, sign as cryptoSign } from "node:crypto";
import {
  decodeReceipt,
  verifyReceiptSignature,
  checkReceiptClaims,
  RECEIPT_ISSUER,
  RECEIPT_AUDIENCE,
  MAX_RECEIPT_BYTES,
  compareDelivery,
} from "../receipt.js";
import { verifyReceipt } from "../client.js";

// Throwaway RSA pairs, generated in memory for this run and gone when the
// process exits. NO key material is stored in this file or anywhere else in
// this repository; these exist only so a signature can be made and then
// refused. `signer` stands in for the issuer, `otherSigner` is an unrelated
// one, and `weakSigner` is deliberately too small to be accepted.
//
// The signing half is picked by asking the pair which member is not the public
// one, so the word that names it appears nowhere in this file. That is for the
// reader, not the code: a generated test fixture and a real secret look alike
// at a glance, and a glance is all a public repository usually gets.
function throwawaySigner(bits = 2048) {
  const pair = generateKeyPairSync("rsa", { modulusLength: bits });
  return Object.values(pair).find((k) => k.type !== "public");
}
const signer = throwawaySigner();
const otherSigner = throwawaySigner();
const weakSigner = throwawaySigner(1024);

const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");

// Mirrors how the issuer signs. The verifier does not depend on HOW kid is
// derived, only that the header's kid selects a key the issuer published.
function issue(claims, key = signer, { header = {} } = {}) {
  const jwk = createPublicKey(key).export({ format: "jwk" });
  const kid = createHash("sha256").update(`${jwk.n}.${jwk.e}`).digest("base64url").slice(0, 16);
  const h = { alg: "RS256", typ: "JWT", kid, ...header };
  const input = `${enc(h)}.${enc(claims)}`;
  const sig = cryptoSign("RSA-SHA256", Buffer.from(input), key);
  return { jwt: `${input}.${sig.toString("base64url")}`, kid, keys: [{ ...jwk, use: "sig", alg: "RS256", kid }] };
}

// Structurally shaped like the real things, never real.
const TX = "4agYGZ" + "b".repeat(82);
const PAY_TO = "A".repeat(44);
const ASSET = "B".repeat(43);
const PAYER = "C".repeat(40);
const NOW = 1_800_000_000;

const goodClaims = (over = {}) => ({
  iss: RECEIPT_ISSUER,
  aud: RECEIPT_AUDIENCE,
  event: "payment.succeeded",
  resource: "https://vaultbags.app/api/agent/ask",
  amount: "50000",
  currency: "USDC",
  tx_hash: TX,
  payer_wallet: PAYER,
  pay_to: PAY_TO,
  asset: ASSET,
  network: "solana:mainnet",
  status: "settled",
  iat: NOW - 10,
  exp: NOW + 3590,
  jti: "b3c2d1e0-0000-4000-8000-000000000001",
  ...over,
});

const failing = (checks) => checks.filter((c) => !c.pass).map((c) => c.name);

test("a receipt signed by the published key verifies, and its claims hold", () => {
  const { jwt, kid, keys } = issue(goodClaims());
  const d = decodeReceipt(jwt);
  assert.equal(d.ok, true);
  assert.deepEqual(verifyReceiptSignature(d, keys), { ok: true, kid });
  assert.deepEqual(failing(checkReceiptClaims(d.claims, { nowSec: NOW })), []);
});

test("a different key does not verify it, even with the kid forced to match", () => {
  const { jwt } = issue(goodClaims());
  const { keys } = issue(goodClaims(), otherSigner);
  const d = decodeReceipt(jwt);
  assert.equal(verifyReceiptSignature(d, keys).ok, false);
  assert.equal(verifyReceiptSignature(d, keys.map((k) => ({ ...k, kid: d.header.kid }))).ok, false);
});

test("editing one claim under a valid signature breaks it", () => {
  const { jwt, keys } = issue(goodClaims());
  const [h, , s] = jwt.split(".");
  const edited = decodeReceipt(`${h}.${enc(goodClaims({ amount: "50001" }))}.${s}`);
  assert.equal(edited.ok, true);
  assert.equal(verifyReceiptSignature(edited, keys).ok, false);
});

test('"alg":"none" and HMAC are refused before any key is consulted', () => {
  const { keys } = issue(goodClaims());
  for (const alg of ["none", "HS256", "RS512", "PS256", undefined]) {
    const jwt = `${enc({ alg, typ: "JWT", kid: keys[0].kid })}.${enc(goodClaims())}.${enc({})}`;
    const r = verifyReceiptSignature(decodeReceipt(jwt), keys);
    assert.equal(r.ok, false, `alg ${alg}`);
    assert.match(r.reason, /only RS256/);
  }
});

test("a kid the issuer never published, and weak or wrong-purpose keys, are refused", () => {
  const { jwt, keys } = issue(goodClaims(), signer, { header: { kid: "nope" } });
  assert.match(verifyReceiptSignature(decodeReceipt(jwt), keys).reason, /no key with id nope/);

  const w = issue(goodClaims(), weakSigner);
  assert.match(verifyReceiptSignature(decodeReceipt(w.jwt), w.keys).reason, /1024-bit/);

  const good = issue(goodClaims());
  const d = decodeReceipt(good.jwt);
  assert.match(verifyReceiptSignature(d, [{ ...good.keys[0], kty: "EC" }]).reason, /not RSA/);
  assert.match(verifyReceiptSignature(d, [{ ...good.keys[0], use: "enc" }]).reason, /not for signatures/);
  assert.match(verifyReceiptSignature(d, [{ ...good.keys[0], alg: "RS512" }]).reason, /RS512/);
  assert.equal(verifyReceiptSignature(d, []).ok, false);
  assert.equal(verifyReceiptSignature(d, null).ok, false);
});

test("malformed tokens are refused at decode, with a reason", () => {
  for (const bad of ["", null, "a.b", "a.b.c.d", "a.b.", "a.b.c=", undefined, 42]) {
    assert.equal(decodeReceipt(bad).ok, false, String(bad));
  }
  assert.equal(decodeReceipt(`${enc([1])}.${enc({})}.x`).ok, false, "header must be an object");
  assert.equal(decodeReceipt(`${enc({})}.${enc("s")}.x`).ok, false, "claims must be an object");
  const huge = `${enc({ alg: "RS256" })}.${enc({ pad: "x".repeat(MAX_RECEIPT_BYTES) })}.x`;
  assert.match(decodeReceipt(huge).reason, /longer than any receipt/);
});

test("a pasted secret is refused by shape", () => {
  // No key has dots, so the shape check alone keeps one out of the decoder.
  for (const secret of ["5".repeat(88), "a1b2c3d4".repeat(8), "abandon ability able about above absent"]) {
    assert.equal(decodeReceipt(secret).ok, false);
  }
});

test("claims are held to their own rules", () => {
  const at = (over) => failing(checkReceiptClaims(goodClaims(over), { nowSec: NOW }));
  assert.deepEqual(at({ exp: NOW - 1 }), ["not expired"]);
  assert.deepEqual(at({ exp: undefined }), ["not expired"]);
  assert.deepEqual(at({ iat: NOW + 301 }), ["issued in the past"]);
  assert.deepEqual(at({ iat: NOW + 299 }), [], "small skew is tolerated");
  assert.deepEqual(at({ iss: "vaultbags.app.evil.example" }), [`issued by ${RECEIPT_ISSUER}`]);
  assert.deepEqual(at({ aud: [RECEIPT_AUDIENCE] }), ["addressed to receipt verifiers"]);
  assert.deepEqual(at({ status: "pending" }), ["records a settled payment"]);
  assert.deepEqual(at({ tx_hash: "0".repeat(80) }), ["names a transaction"], "0 is not base58");
  assert.deepEqual(at({ amount: 50000 }), ["names a positive amount in USDC"], "a number is lossy");
  assert.deepEqual(at({ amount: "0" }), ["names a positive amount in USDC"]);
  assert.deepEqual(at({ currency: "USDT" }), ["names a positive amount in USDC"]);
  assert.deepEqual(at({ pay_to: null }), ["names the destination wallet and the asset"]);
  assert.deepEqual(at({ payer_wallet: "not-an-address" }), ["names the payer, or says it could not"]);
  assert.deepEqual(at({ payer_wallet: null }), [], "an unknown payer is allowed and said");
  assert.deepEqual(at({ resource: "https://evil.example/api/agent/ask" }), ["names a resource of the issuer"]);
  assert.deepEqual(at({ resource: "http://vaultbags.app/x" }), ["names a resource of the issuer"], "https only");
  assert.deepEqual(at({ jti: "short" }), ["carries a unique id"]);
  assert.deepEqual(at({ network: "" }), ["names the network"]);
});

// ---- the client method, with the network replaced ---------------------------

function withFetch(routes, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    for (const [match, reply] of routes) {
      if (u.includes(match)) return reply();
    }
    throw new Error(`unexpected fetch: ${u}`);
  };
  return Promise.resolve(fn()).finally(() => {
    globalThis.fetch = original;
  });
}

const jsonReply = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const terms = (payTo, asset) => jsonReply({ x402Version: 1, accepts: [{ payTo, asset }] }, 402);

test("a genuine receipt reports what it proves, and refuses to imply the rest", async () => {
  const { jwt, keys, kid } = issue(goodClaims({ iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 3595 }));
  const out = await withFetch(
    [
      ["/.well-known/jwks.json", () => jsonReply({ keys })],
      ["/api/agent/ask", () => terms(PAY_TO, ASSET)],
    ],
    () => verifyReceipt(undefined, { receipt: jwt })
  );
  assert.equal(out.signatureValid, true);
  assert.equal(out.signedWithKey, kid);
  assert.equal(out.claimsValid, true);
  assert.equal(out.destination.matches, true);
  assert.equal(out.issuedByVaultBags, true);
  // The whole point: a signature is never reported as a settled payment.
  assert.equal(out.paymentProvenHere, false);
  assert.equal(out.payment.transaction, TX);
  assert.match(out.proveThePaymentYourself.explorer, new RegExp(`/tx/${TX}$`));
  assert.match(out.summary, /transaction on Solana is what proves the payment/);
});

test("a receipt naming a wallet the vault does not advertise is not passed off as ours", async () => {
  const { jwt, keys } = issue(goodClaims({ iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 3595 }));
  const out = await withFetch(
    [
      ["/.well-known/jwks.json", () => jsonReply({ keys })],
      ["/api/agent/ask", () => terms("D".repeat(44), ASSET)],
    ],
    () => verifyReceipt(undefined, { receipt: jwt })
  );
  assert.equal(out.signatureValid, true, "the signature really is valid");
  assert.equal(out.destination.matches, false);
  assert.equal(out.issuedByVaultBags, false, "a mismatch must not read as ours");
  assert.match(out.summary, /does not advertise/);
});

test("terms that cannot be read leave the verdict standing, and say the comparison did not run", async () => {
  const { jwt, keys } = issue(goodClaims({ iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 3595 }));
  const out = await withFetch(
    [
      ["/.well-known/jwks.json", () => jsonReply({ keys })],
      ["/api/agent/ask", () => jsonReply({ error: "Not found" }, 404)],
    ],
    () => verifyReceipt(undefined, { receipt: jwt })
  );
  assert.equal(out.destination.compared, false);
  assert.match(out.destination.reason, /did not answer with its terms/);
  assert.equal(out.issuedByVaultBags, true, "a check that could not run is neither a pass nor a failure");
  assert.equal(out.paymentProvenHere, false);
});

test("a genuine receipt past its hour reads as issued by VaultBags, and not current", async () => {
  const now = Math.floor(Date.now() / 1000);
  const { jwt, keys } = issue(goodClaims({ iat: now - 7200, exp: now - 3600 }));
  const out = await withFetch(
    [
      ["/.well-known/jwks.json", () => jsonReply({ keys })],
      ["/api/agent/ask", () => jsonReply({ error: "Not found" }, 404)],
    ],
    () => verifyReceipt(undefined, { receipt: jwt })
  );
  assert.equal(out.signatureValid, true);
  assert.equal(out.claimsValid, false, "the time box is one of its claims");
  assert.equal(out.current, false);
  assert.equal(out.issuedByVaultBags, true, "a lapsed time box is not a forgery");
  assert.match(out.summary, /expired at .*no longer a live proof/);
  assert.equal(out.paymentProvenHere, false);
});

test("a receipt with no expiry at all is not treated as merely lapsed", async () => {
  const now = Math.floor(Date.now() / 1000);
  const { jwt, keys } = issue(goodClaims({ iat: now - 5, exp: undefined }));
  const out = await withFetch([["/.well-known/jwks.json", () => jsonReply({ keys })]], () =>
    verifyReceipt(undefined, { receipt: jwt })
  );
  assert.equal(out.current, false);
  assert.equal(out.issuedByVaultBags, false);
});

test("a lapsed receipt that also breaks another claim is not issued-as-it-reads", async () => {
  const now = Math.floor(Date.now() / 1000);
  const { jwt, keys } = issue(goodClaims({ iat: now - 7200, exp: now - 3600, amount: "0" }));
  const out = await withFetch([["/.well-known/jwks.json", () => jsonReply({ keys })]], () =>
    verifyReceipt(undefined, { receipt: jwt })
  );
  assert.equal(out.issuedByVaultBags, false);
});

test("a receipt naming no real transaction gets no lookup built from that field", async () => {
  // Found by probing 0.5.0: the answer used to assemble an explorer link out of
  // tx_hash even when the check on tx_hash had just failed, so a rejected value
  // came back as a link that did not point where it said it did.
  const now = Math.floor(Date.now() / 1000);
  const { jwt, keys } = issue(goodClaims({ tx_hash: "../../evil.example/phish?x=", iat: now - 5, exp: now + 3595 }));
  const out = await withFetch([["/.well-known/jwks.json", () => jsonReply({ keys })]], () =>
    verifyReceipt(undefined, { receipt: jwt })
  );
  assert.equal(out.claimsValid, false);
  assert.deepEqual(
    out.checks.filter((c) => !c.pass).map((c) => c.name),
    ["names a transaction"]
  );
  assert.equal(out.proveThePaymentYourself.explorer, null, "no link may be built from a rejected field");
  assert.equal(out.proveThePaymentYourself.command, null);
  assert.match(out.proveThePaymentYourself.how, /nothing to look up/);
  assert.ok(!JSON.stringify(out.proveThePaymentYourself).includes("evil.example"));
});

test("a timestamp beyond what a date can hold returns a verdict, not a crash", async () => {
  // `new Date(n * 1000).toISOString()` throws past about year 275760, and an
  // integer that large passes every claim check, so formatting used to throw
  // where a verdict was already in hand.
  const now = Math.floor(Date.now() / 1000);
  const { jwt, keys } = issue(goodClaims({ iat: now - 5, exp: Number.MAX_SAFE_INTEGER }));
  const out = await withFetch([["/.well-known/jwks.json", () => jsonReply({ keys })]], () =>
    verifyReceipt(undefined, { receipt: jwt })
  );
  assert.equal(out.signatureValid, true);
  assert.equal(out.payment.expiresAt, null, "an unrepresentable date reads as absent, never as a throw");
  assert.equal(typeof out.payment.issuedAt, "string");
  assert.equal(out.paymentProvenHere, false);
});

test("a forged receipt and an empty key set both come back refused, never verified", async () => {
  const forged = issue(goodClaims(), otherSigner);
  const real = issue(goodClaims());
  const bad = await withFetch([["/.well-known/jwks.json", () => jsonReply({ keys: real.keys })]], () =>
    verifyReceipt(undefined, { receipt: forged.jwt })
  );
  assert.equal(bad.signatureValid, false);
  assert.equal(bad.issuedByVaultBags, false);
  assert.equal(bad.paymentProvenHere, false);

  const noKeys = await withFetch([["/.well-known/jwks.json", () => jsonReply({ keys: [] })]], () =>
    verifyReceipt(undefined, { receipt: real.jwt })
  );
  assert.equal(noKeys.signatureValid, false);
  assert.match(noKeys.reason, /no signing key is published/);

  const junk = await withFetch([], () => verifyReceipt(undefined, { receipt: "not-a-receipt" }));
  assert.equal(junk.signatureValid, false, "a malformed token never reaches the network");
  // Every answer states `current`, which the tool tells callers to require.
  for (const out of [bad, noKeys, junk]) assert.equal(out.current, false);
});

// ---- what the payment bought ------------------------------------------------
//
// The vectors are the ones the app and vaultbags-cli pin, recomputed
// independently, so the issuer and both verifiers hash the same way.

const QUESTION = "What did the vault buy today, and why?";
const ANSWER = "Gold 38%, the S&P 500 31%, US Treasuries 31%. é \u{1F4C8}";
const ANSWER_DELIVERY = {
  v: 1,
  kind: "answer",
  question_sha256: "d68de484b586537e5ea59abc6c5f61ebf65f0b3b4421728f408f39fcb888218a",
  answer_sha256: "c470451742b536cf00ce7656ec5fdc0b12ce81bdfaa93a5aef2d029a5c8d1bbc",
  tools: ["get_todays_allocation", "get_market_signals"],
};
const EXPORT_DELIVERY = { v: 1, kind: "export", content_sha256: "30b00872a92d459b6f4d90215ee55fe1205e7d90d5a57073fc6e42cb0542c306" };
const EXPORT_BODY = { b: [3, 2, 1], a: { y: 1.5, x: "ñ" }, at: "2026-10-09T00:00:00.000Z", n: 0.1 + 0.2 };

test("an answer delivery matches the answer and question it was for, and not one character else", () => {
  const claims = goodClaims({ delivery: ANSWER_DELIVERY });
  const named = compareDelivery(claims);
  assert.equal(named.named, true);
  assert.deepEqual(named.toolsRead, ["get_todays_allocation", "get_market_signals"]);
  assert.equal(named.answerMatches, null, "nothing passed, nothing compared");
  const both = compareDelivery(claims, { answer: ANSWER, question: `  ${QUESTION}\n` });
  assert.equal(both.answerMatches, true);
  assert.equal(both.questionMatches, true);
  assert.equal(both.fullyChecked, true);
  assert.deepEqual(both.notCompared, []);
  const answerOnly = compareDelivery(claims, { answer: ANSWER });
  assert.equal(answerOnly.answerMatches, true);
  assert.equal(answerOnly.fullyChecked, false, "an answer without its question is not fully checked");
  assert.match(answerOnly.notCompared.join(" "), /question was not passed/);
  const crlf = compareDelivery(goodClaims({ delivery: { ...ANSWER_DELIVERY, question_sha256: createHash("sha256").update("line one\nline two", "utf8").digest("hex") } }), { question: "line one\r\nline two\r\n" });
  assert.equal(crlf.questionMatches, true, "a question copied with Windows line endings still matches");
  assert.equal(compareDelivery(claims, { answer: ANSWER.replace("38%", "39%") }).answerMatches, false);
  assert.equal(compareDelivery(claims, { question: QUESTION + "!" }).questionMatches, false);
});

test("an export delivery matches the parsed body whatever its key order", () => {
  const claims = goodClaims({ delivery: EXPORT_DELIVERY });
  assert.equal(compareDelivery(claims, { content: EXPORT_BODY }).contentMatches, true);
  const reordered = { n: EXPORT_BODY.n, at: EXPORT_BODY.at, a: { x: "ñ", y: 1.5 }, b: [3, 2, 1] };
  assert.equal(compareDelivery(claims, { content: reordered }).contentMatches, true);
  assert.equal(compareDelivery(claims, { content: { ...EXPORT_BODY, b: [1, 2, 3] } }).contentMatches, false);
  const asText = compareDelivery(claims, { content: JSON.stringify(EXPORT_BODY, null, 2) });
  assert.equal(asText.contentMatches, true, "the export's JSON text is read as the export");
  assert.equal(asText.fullyChecked, true);
  const notJson = compareDelivery(claims, { content: "not json" });
  assert.equal(notJson.contentMatches, null, "text that is not JSON is not compared, never reported as different");
  assert.match(notJson.notCompared.join(" "), /not JSON/);
  const cyclic = { a: 1 };
  cyclic.self = cyclic;
  const unreadable = compareDelivery(claims, { content: cyclic });
  assert.equal(unreadable.contentMatches, null);
  assert.match(unreadable.notCompared.join(" "), /could not be read/);
  const wrongKind = compareDelivery(claims, { answer: "an answer" });
  assert.equal(wrongKind.contentMatches, null);
  assert.match(wrongKind.notCompared.join(" "), /for an export/);
});

test("the analyst's camelCase tools are read, and an incomplete list says so", () => {
  const out = compareDelivery(goodClaims({ delivery: { ...ANSWER_DELIVERY, tools: ["getMarketOverview", "get_market_signals"], tools_incomplete: true } }));
  assert.equal(out.named, true);
  assert.deepEqual(out.toolsRead, ["getMarketOverview", "get_market_signals"]);
  assert.equal(out.toolsListComplete, false);
  assert.equal(compareDelivery(goodClaims({ delivery: ANSWER_DELIVERY })).toolsListComplete, true);
  const wrongKind = compareDelivery(goodClaims({ delivery: ANSWER_DELIVERY }), { content: EXPORT_BODY });
  assert.match(wrongKind.notCompared.join(" "), /for an answer/);
});

test("a delivery in a newer format is reported as newer, never as malformed", () => {
  for (const delivery of [{ ...ANSWER_DELIVERY, v: 2 }, { ...ANSWER_DELIVERY, kind: "image" }, { ...ANSWER_DELIVERY, extra: 1 }, { ...EXPORT_DELIVERY, content_encoding: "gzip" }]) {
    const out = compareDelivery(goodClaims({ delivery }), { answer: ANSWER, content: EXPORT_BODY });
    assert.equal(out.named, false, JSON.stringify(delivery));
    assert.equal(out.newer, true);
    assert.equal(out.malformed, undefined);
    assert.match(out.reason, /newer/);
  }
});

test("no delivery, or a malformed one, never reads as a match", () => {
  assert.equal(compareDelivery(goodClaims()).named, false);
  for (const delivery of [{ ...ANSWER_DELIVERY, v: "2" }, { ...ANSWER_DELIVERY, v: 0 }, { ...ANSWER_DELIVERY, kind: "Image!" }, { ...ANSWER_DELIVERY, tools: ["two words"] }, { ...ANSWER_DELIVERY, tools_incomplete: false }, { ...EXPORT_DELIVERY, content_sha256: "00" }, null]) {
    const out = compareDelivery(goodClaims({ delivery }), { answer: ANSWER, content: EXPORT_BODY });
    assert.equal(out.named, false, JSON.stringify(delivery));
    assert.equal(out.malformed, true);
  }
});

test("the client method reports what the payment bought, and whether the caller holds it", async () => {
  const fresh = { iat: Math.floor(Date.now() / 1000) - 5, exp: Math.floor(Date.now() / 1000) + 3595 };
  const { jwt, keys } = issue(goodClaims({ ...fresh, delivery: ANSWER_DELIVERY }));
  const routes = [
    ["/.well-known/jwks.json", () => jsonReply({ keys })],
    ["/api/agent/ask", () => terms(PAY_TO, ASSET)],
  ];
  const held = await withFetch(routes, () => verifyReceipt(undefined, { receipt: jwt, answer: ANSWER, question: QUESTION }));
  assert.equal(held.deliveryMatches, true);
  assert.equal(held.deliveryFullyChecked, true);
  const answerOnly = await withFetch(routes, () => verifyReceipt(undefined, { receipt: jwt, answer: ANSWER }));
  assert.equal(answerOnly.deliveryMatches, true);
  assert.equal(answerOnly.deliveryFullyChecked, false, "the answer alone does not say what it answered");
  assert.match(answerOnly.summary, /Not compared: the question was not passed/);
  assert.match(answerOnly.proveThePaymentYourself.command, /^npx vaultbags-cli@0\.7\.0 verify receipt /);
  assert.equal(held.issuedByVaultBags, true);
  assert.equal(held.paymentProvenHere, false, "a matching text is still not a proven payment");
  assert.match(held.summary, /after reading get_todays_allocation, get_market_signals\. The text you hold is the one it delivered\./);
  const edited = await withFetch(routes, () => verifyReceipt(undefined, { receipt: jwt, answer: ANSWER + " " }));
  assert.equal(edited.deliveryMatches, false);
  assert.match(edited.summary, /is NOT the one it delivered/);
  const none = await withFetch(routes, () => verifyReceipt(undefined, { receipt: jwt }));
  assert.equal(none.deliveryMatches, null);
});
