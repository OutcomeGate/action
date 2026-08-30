import assert from "node:assert/strict";
import test from "node:test";

import { createRefundEnvironment } from "../src/fixtures/refunds.js";
import type { JsonValue } from "../src/types.js";

const initialState: JsonValue = {
  orders: {
    "order-1": {
      id: "order-1",
      amount: 40,
      currency: "USD",
      status: "paid",
      refundable: true,
    },
  },
  tickets: {
    "ticket-1": {
      id: "ticket-1",
      orderId: "order-1",
      status: "open",
    },
  },
  refunds: [],
  notifications: [],
  escalations: [],
};

test("refund creation is idempotent only for the same key", async () => {
  const environment = createRefundEnvironment(initialState);
  const args = {
    orderId: "order-1",
    amount: 40,
    currency: "USD",
    idempotencyKey: "stable-key",
  };
  await environment.call("refunds.create", args);
  await environment.call("refunds.create", args);

  const afterStableRetry = environment.snapshot() as {
    refunds: JsonValue[];
  };
  assert.equal(afterStableRetry.refunds.length, 1);

  await environment.call("refunds.create", {
    ...args,
    idempotencyKey: "new-key",
  });
  const afterUnsafeRetry = environment.snapshot() as {
    refunds: JsonValue[];
  };
  assert.equal(afterUnsafeRetry.refunds.length, 2);
});

test("fixture state is fresh for every environment", async () => {
  const first = createRefundEnvironment(initialState);
  await first.call("refunds.create", {
    orderId: "order-1",
    amount: 40,
    currency: "USD",
    idempotencyKey: "key",
  });
  const second = createRefundEnvironment(initialState);
  const secondState = second.snapshot() as { refunds: JsonValue[] };
  assert.equal(secondState.refunds.length, 0);
});
