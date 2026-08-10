// The plugin surface, checked against itself.
//
// client.js is covered next door. index.js was not covered at all, and it is
// the half a consumer's model actually sees: the client can be perfect while
// the action that exposes it was never added to the array, and nothing would
// say so until someone asked an agent a question it should have been able to
// answer. That failure is silent by construction, which is the kind worth a
// test.
//
// index.js imports zod, a peer the consumer supplies, so it is not imported
// here: this package deliberately installs nothing of its own and a test is not
// a good enough reason to change that. It is read as text instead, which is
// enough to check the two halves agree, and cannot be fooled by a stub.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { methods } from "../client.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const index = readFileSync(join(root, "index.js"), "utf8");

// getRwaPerformance -> VAULTBAGS_GET_RWA_PERFORMANCE
const actionNameFor = (method) =>
  "VAULTBAGS_" + method.replace(/([A-Z])/g, "_$1").toUpperCase();

test("every client method is exposed as an action", () => {
  for (const method of Object.keys(methods)) {
    const name = actionNameFor(method);
    assert.ok(
      index.includes(`name: "${name}"`),
      `${method}() exists but no action named ${name} defines it`
    );
  }
});

test("every action defined is also registered in the actions array", () => {
  const defined = [...index.matchAll(/name: "(VAULTBAGS_[A-Z_]+)"/g)].map((m) => m[1]);
  assert.ok(defined.length > 0, "no actions found; the file shape changed");

  // The `const xAction = readAction({ name: "VAULTBAGS_X" ...` declarations, and
  // the array at the bottom that decides which of them ship. A definition that
  // never reaches the array is invisible to a consumer.
  const declarations = [...index.matchAll(/const (\w+Action) = readAction\(/g)].map((m) => m[1]);
  const arrayBlock = index.slice(index.indexOf("actions: ["));

  for (const decl of declarations) {
    assert.ok(
      new RegExp(`\\b${decl}\\b`).test(arrayBlock),
      `${decl} is defined but never added to the actions array`
    );
  }
  assert.equal(
    declarations.length,
    Object.keys(methods).length,
    "the number of actions and the number of client methods have drifted apart"
  );
});

test("no two actions share a name", () => {
  const names = [...index.matchAll(/name: "(VAULTBAGS_[A-Z_]+)"/g)].map((m) => m[1]);
  const seen = new Set();
  for (const n of names) {
    assert.ok(!seen.has(n), `${n} is defined twice; the later one would win silently`);
    seen.add(n);
  }
});

test("every action carries enough description for a model to pick it", () => {
  // A one-line description is how a tool gets called for the wrong question.
  //
  // Split on the DECLARATION, not on "readAction({": the helper's own signature
  // is written that way too, so splitting on the call shape counts one block
  // that is not an action at all.
  const blocks = index.split(/const \w+Action = readAction\(\{/).slice(1);
  assert.equal(blocks.length, Object.keys(methods).length);
  for (const block of blocks) {
    const name = block.match(/name: "(VAULTBAGS_[A-Z_]+)"/)?.[1];
    assert.ok(name, "an action has no name");
    const description = block.match(/description:\s*\n?\s*"([^"]{0,4000})"/)?.[1] || "";
    assert.ok(
      description.length > 120,
      `${name} has a description of ${description.length} chars, too thin to disambiguate`
    );
    assert.ok(
      /similes: \[/.test(block),
      `${name} has no similes, so a paraphrased question will not reach it`
    );
  }
});
