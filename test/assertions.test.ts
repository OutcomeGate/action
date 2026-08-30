import assert from "node:assert/strict";
import test from "node:test";

import { evaluateAssertion, readJsonPointer } from "../src/assertions.js";
import type { JsonValue, ToolEvent } from "../src/types.js";

const state: JsonValue = {
  refunds: [{ orderId: "order-1", amount: 25 }],
  nested: { enabled: true },
};

test("reads RFC 6901-style JSON pointers", () => {
  assert.equal(readJsonPointer(state, "/refunds/0/orderId"), "order-1");
  assert.equal(readJsonPointer(state, "/nested/enabled"), true);
});

test("evaluates equality and absence without guessing", () => {
  const equality = evaluateAssertion(
    {
      id: "amount",
      type: "json_pointer",
      source: "state",
      pointer: "/refunds/0/amount",
      operator: "equals",
      expected: 25,
    },
    { state, events: [] },
  );
  const absence = evaluateAssertion(
    {
      id: "no-duplicate",
      type: "json_pointer",
      source: "state",
      pointer: "/refunds/1",
      operator: "absent",
    },
    { state, events: [] },
  );

  assert.equal(equality.passed, true);
  assert.equal(absence.passed, true);
});

test("evaluates event counts and order", () => {
  const event = (sequence: number, tool: string): ToolEvent => ({
    sequence,
    requestId: `call-${sequence}`,
    tool,
    arguments: {},
    outcome: "ok",
    committed: true,
    beforeStateHash: `before-${sequence}`,
    afterStateHash: `after-${sequence}`,
    durationMs: 0,
  });
  const events = [
    event(1, "orders.get"),
    event(2, "refunds.create"),
    event(3, "tickets.update"),
  ];

  assert.equal(
    evaluateAssertion(
      {
        id: "one-refund",
        type: "event_count",
        tool: "refunds.create",
        expected: 1,
      },
      { state, events },
    ).passed,
    true,
  );
  assert.equal(
    evaluateAssertion(
      {
        id: "ordered",
        type: "event_order",
        tools: ["refunds.create", "tickets.update"],
      },
      { state, events },
    ).passed,
    true,
  );
  assert.equal(
    evaluateAssertion(
      {
        id: "wrong-order",
        type: "event_order",
        tools: ["tickets.update", "refunds.create"],
      },
      { state, events },
    ).passed,
    false,
  );
});
