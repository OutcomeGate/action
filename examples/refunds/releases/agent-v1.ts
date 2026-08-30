import { DriverToolError } from "../../../src/errors.js";
import { runDriverAgent } from "../../../src/driver/client.js";
import type { JsonValue } from "../../../src/types.js";

function asRecord(value: JsonValue, label: string): Record<string, JsonValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function stringField(record: Record<string, JsonValue>, field: string): string {
  const value = record[field];
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string`);
  }
  return value;
}

function numberField(record: Record<string, JsonValue>, field: string): number {
  const value = record[field];
  if (typeof value !== "number") {
    throw new Error(`${field} must be a number`);
  }
  return value;
}

runDriverAgent(async ({ task, call }) => {
  const taskRecord = asRecord(task, "task");
  const ticketId = stringField(taskRecord, "ticketId");
  const ticket = asRecord(
    await call("tickets.get", { ticketId }),
    "ticket",
  );
  const orderId = stringField(ticket, "orderId");
  const order = asRecord(await call("orders.get", { orderId }), "order");

  if (order.refundable !== true) {
    await call("cases.escalate", {
      ticketId,
      reason: "order_not_refundable",
    });
    await call("notifications.send", {
      ticketId,
      template: "refund-escalated",
    });
    return { action: "escalated", ticketId, orderId };
  }

  const existing = await call("refunds.list", { orderId });
  if (!Array.isArray(existing)) {
    throw new Error("refunds.list did not return an array");
  }
  if (existing.length > 0) {
    await call("tickets.update", { ticketId, status: "resolved" });
    await call("notifications.send", {
      ticketId,
      template: "refund-confirmed",
    });
    return { action: "already_refunded", ticketId, orderId };
  }

  const idempotencyKey = `${ticketId}:${orderId}:refund`;
  const refundArguments = {
    orderId,
    amount: numberField(order, "amount"),
    currency: stringField(order, "currency"),
    idempotencyKey,
  };
  try {
    await call("refunds.create", refundArguments);
  } catch (error) {
    if (!(error instanceof DriverToolError) || error.code !== "response_timeout") {
      throw error;
    }
    // Retrying with the same key reconciles an ambiguous timeout safely.
    await call("refunds.create", refundArguments);
  }

  await call("tickets.update", { ticketId, status: "resolved" });
  await call("notifications.send", {
    ticketId,
    template: "refund-confirmed",
  });
  return { action: "refunded", ticketId, orderId };
});
