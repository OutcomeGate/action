import assert from "node:assert/strict";
import test from "node:test";

import { parseStrictJson, StrictJsonError } from "../src/strict-json.js";

test("strict JSON accepts one unambiguous complete document", () => {
  assert.deepEqual(
    parseStrictJson(
      '{"object":{"same":1},"array":[{"same":2}],"number":-1.5e2,"text":"line\\nvalue","truth":true,"none":null}',
    ),
    {
      object: { same: 1 },
      array: [{ same: 2 }],
      number: -150,
      text: "line\nvalue",
      truth: true,
      none: null,
    },
  );
});

test("strict JSON rejects literal and escape-equivalent duplicate members", () => {
  for (const input of [
    '{"x":"first","x":"last"}',
    '{"\\u0078":"first","x":"last"}',
    '{"nested":{"x":1,"\\u0078":2}}',
  ]) {
    assert.throws(
      () => parseStrictJson(input),
      (error: unknown) =>
        error instanceof StrictJsonError && error.code === "duplicate_member",
    );
  }
});

test("strict JSON diagnostics do not reflect invalid input", () => {
  const canary = "opaque-sensitive-input";
  assert.throws(
    () => parseStrictJson(`{"x":${canary}}`),
    (error: unknown) => {
      assert.ok(error instanceof StrictJsonError);
      assert.equal(error.code, "invalid_syntax");
      assert.equal(error.message.includes(canary), false);
      return true;
    },
  );
});

test("strict JSON rejects numbers outside the finite runtime range", () => {
  for (const input of ["1e400", "-1e400", '{"nested":[1e400]}']) {
    assert.throws(
      () => parseStrictJson(input),
      (error: unknown) =>
        error instanceof StrictJsonError &&
        error.code === "number_out_of_range",
    );
  }
});
