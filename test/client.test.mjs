// What this package promises a caller, held to by tests rather than by reading.
//
// Everything here is offline: fetch is replaced for the duration of a test, so
// nothing reaches the network and the suite is the same on a plane as in CI.
//
//   npm test

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  resolveBaseUrl,
  resolveTimeoutMs,
  methods,
  getTodaysAllocation,
  simulateAllocation,
} from "../client.js";

// Swap fetch for one call and hand back what it was asked.
function withFetch(impl, fn) {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return impl(String(url), init);
  };
  return Promise.resolve(fn(seen)).finally(() => {
    globalThis.fetch = original;
  });
}

const jsonOk = (body) => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
});

test("the default base is production, and an override wins over it", () => {
  assert.equal(resolveBaseUrl(undefined), DEFAULT_BASE_URL);
  assert.equal(resolveBaseUrl("https://staging.example"), "https://staging.example");
  assert.equal(
    resolveBaseUrl({ config: { OTHER_API_KEYS: { VAULTBAGS_API_URL: "https://from-config.example" } } }),
    "https://from-config.example",
  );
});

test("a trailing slash never becomes a double slash in a path", async () => {
  assert.equal(resolveBaseUrl("https://x.example///"), "https://x.example");
  await withFetch(
    () => jsonOk({}),
    async (seen) => {
      await getTodaysAllocation("https://x.example/");
      assert.equal(seen[0].url, "https://x.example/api/agent/todays-allocation");
    },
  );
});

test("an agent object without the config key still resolves to production", () => {
  assert.equal(resolveBaseUrl({}), DEFAULT_BASE_URL);
  assert.equal(resolveBaseUrl({ config: {} }), DEFAULT_BASE_URL);
  assert.equal(resolveBaseUrl({ config: { OTHER_API_KEYS: {} } }), DEFAULT_BASE_URL);
});

test("the timeout has a default, takes an override, and refuses nonsense", () => {
  assert.equal(resolveTimeoutMs(undefined), DEFAULT_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs({ config: { OTHER_API_KEYS: { VAULTBAGS_TIMEOUT_MS: 2500 } } }), 2500);
  for (const bad of [0, -1, "abc", null, {}]) {
    assert.equal(
      resolveTimeoutMs({ config: { OTHER_API_KEYS: { VAULTBAGS_TIMEOUT_MS: bad } } }),
      DEFAULT_TIMEOUT_MS,
      `a timeout of ${JSON.stringify(bad)} must fall back to the default`,
    );
  }
});

test("a request that never answers ends as an error, not as a wait without end", async () => {
  await withFetch(
    (_url, init) =>
      // Never resolves on its own; only the abort signal can end it, which is
      // the whole point of the check.
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }),
    async () => {
      const started = Date.now();
      await assert.rejects(
        () => getTodaysAllocation({ config: { OTHER_API_KEYS: { VAULTBAGS_TIMEOUT_MS: 150 } } }),
        (err) => /no answer within 150ms/.test(err.message),
      );
      assert.ok(Date.now() - started < 3000, "it must give up promptly, not hang");
    },
  );
});

test("a signal is always attached, so no call can outlive its timeout", async () => {
  await withFetch(
    () => jsonOk({}),
    async (seen) => {
      await getTodaysAllocation();
      assert.ok(seen[0].init?.signal, "every request carries an abort signal");
    },
  );
});

test("an error status surfaces the server's message, not a bare status", async () => {
  await withFetch(
    () => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: "Too many requests" }) }),
    async () => {
      await assert.rejects(
        () => getTodaysAllocation(),
        (err) => /Too many requests/.test(err.message),
      );
    },
  );
});

test("a non-JSON answer is reported as one, with its status", async () => {
  await withFetch(
    () => ({ ok: false, status: 502, text: async () => "<html>gateway</html>" }),
    async () => {
      await assert.rejects(
        () => getTodaysAllocation(),
        (err) => /non-JSON response \(HTTP 502\)/.test(err.message),
      );
    },
  );
});

test("an empty body is an empty object, not a crash", async () => {
  await withFetch(
    () => ({ ok: true, status: 200, text: async () => "" }),
    async () => {
      assert.deepEqual(await getTodaysAllocation(), {});
    },
  );
});

test("only declared signals are sent, and empty values are left out", async () => {
  await withFetch(
    () => jsonOk({}),
    async (seen) => {
      await simulateAllocation(undefined, {
        vix: 18,
        fearGreed: 55,
        notASignal: "drop me",
        realYield: undefined,
        hyOas: "",
      });
      const url = new URL(seen[0].url);
      assert.equal(url.searchParams.get("vix"), "18");
      assert.equal(url.searchParams.get("fearGreed"), "55");
      assert.equal(url.searchParams.get("notASignal"), null, "an undeclared key is never forwarded");
      assert.equal(url.searchParams.get("realYield"), null, "undefined is not sent as a value");
      assert.equal(url.searchParams.get("hyOas"), null, "an empty string is not sent as a value");
    },
  );
});

test("every declared method is a callable function", () => {
  assert.ok(methods && typeof methods === "object");
  const names = Object.keys(methods);
  assert.ok(names.length > 0, "the package declares at least one method");
  for (const name of names) {
    assert.equal(typeof methods[name], "function", `${name} must be callable`);
  }
});

test("no method reaches anywhere but the agent surface of the resolved base", async () => {
  await withFetch(
    () => jsonOk({}),
    async (seen) => {
      for (const [name, fn] of Object.entries(methods)) {
        try {
          await fn("https://base.example");
        } catch {
          // A method needing arguments may reject; the URL it tried is what
          // this asserts, and that is already recorded.
        }
        const last = seen[seen.length - 1];
        if (!last) continue;
        assert.ok(
          last.url.startsWith("https://base.example/api/agent/"),
          `${name} must call the agent surface, got ${last.url}`,
        );
      }
    },
  );
});
