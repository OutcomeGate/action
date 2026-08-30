import assert from "node:assert/strict";
import test from "node:test";

import { SuiteValidationError } from "../src/errors.js";
import { parseSuite } from "../src/suite.js";

test("rejects malformed suites before execution", () => {
  assert.throws(() => parseSuite({}), SuiteValidationError);
});

test("rejects unsupported assertion types", () => {
  assert.throws(
    () =>
      parseSuite({
        schemaVersion: "agentci.suite.v1",
        name: "bad",
        version: "1",
        fixture: "refunds.v1",
        gate: { minPassRate: 1 },
        scenarios: [
          {
            id: "bad-case",
            description: "bad assertion",
            task: {},
            initialState: {},
            assertions: [{ id: "bad", type: "llm_judge" }],
          },
        ],
      }),
    SuiteValidationError,
  );
});

test("rejects misspelled state roots and event tools", () => {
  assert.throws(
    () =>
      parseSuite({
        schemaVersion: "agentci.suite.v1",
        name: "typos",
        version: "1",
        fixture: "refunds.v1",
        gate: { minPassRate: 1 },
        scenarios: [
          {
            id: "typo-case",
            description: "typoed oracle",
            task: {},
            initialState: {
              orders: {},
              tickets: {},
              refunds: [],
              notifications: [],
              escalations: [],
            },
            assertions: [
              {
                id: "misspelled-root",
                type: "json_pointer",
                source: "state",
                pointer: "/refudns/0",
                operator: "absent",
              },
              {
                id: "misspelled-tool",
                type: "event_count",
                tool: "refudns.create",
                expected: 0,
              },
            ],
          },
        ],
      }),
    SuiteValidationError,
  );
});

test("rejects malformed nested refund fixture state", () => {
  assert.throws(
    () =>
      parseSuite({
        schemaVersion: "agentci.suite.v1",
        name: "bad-state",
        version: "1",
        fixture: "refunds.v1",
        gate: { minPassRate: 1 },
        scenarios: [
          {
            id: "bad-state-case",
            description: "malformed nested state",
            task: {},
            initialState: {
              orders: { "order-1": {} },
              tickets: {},
              refunds: [],
              notifications: [],
              escalations: [],
            },
            assertions: [
              {
                id: "no-refund",
                type: "json_pointer",
                source: "state",
                pointer: "/refunds/0",
                operator: "absent",
              },
            ],
          },
        ],
      }),
    SuiteValidationError,
  );
});

test("rejects unknown nested state fields in absence assertions", () => {
  assert.throws(
    () =>
      parseSuite({
        schemaVersion: "agentci.suite.v1",
        name: "bad-absence-oracle",
        version: "1",
        fixture: "refunds.v1",
        gate: { minPassRate: 1 },
        scenarios: [
          {
            id: "bad-absence-case",
            description: "a typo must not silently satisfy absence",
            task: {},
            initialState: {
              orders: {},
              tickets: {},
              refunds: [],
              notifications: [],
              escalations: [],
            },
            assertions: [
              {
                id: "misspelled-refund-field",
                type: "json_pointer",
                source: "state",
                pointer: "/refunds/0/ordrId",
                operator: "absent",
              },
            ],
          },
        ],
      }),
    SuiteValidationError,
  );
});

test("rejects unknown fields instead of silently applying defaults", () => {
  assert.throws(
    () =>
      parseSuite({
        schemaVersion: "agentci.suite.v1",
        name: "unknown-field",
        version: "1",
        fixture: "external.v1",
        gate: { minPassRate: 1 },
        scenarios: [
          {
            id: "case",
            description: "misspelled timeout",
            task: {},
            initialState: {},
            timeOutMs: 1,
            assertions: [
              {
                id: "count",
                type: "event_count",
                tool: "noop",
                expected: 0,
              },
            ],
          },
        ],
      }),
    /timeOutMs is not supported/,
  );
});

test("rejects duplicate fault schedules for external fixtures", () => {
  assert.throws(
    () =>
      parseSuite({
        schemaVersion: "agentci.suite.v1",
        name: "duplicate-fault",
        version: "1",
        fixture: "external.v1",
        gate: { minPassRate: 1 },
        scenarios: [
          {
            id: "case",
            description: "ambiguous schedule",
            task: {},
            initialState: {},
            faults: [
              {
                tool: "noop",
                onCall: 1,
                phase: "before",
                error: { code: "first", message: "first" },
              },
              {
                tool: "noop",
                onCall: 1,
                phase: "after",
                error: { code: "second", message: "second" },
              },
            ],
            assertions: [
              {
                id: "count",
                type: "event_count",
                tool: "noop",
                expected: 0,
              },
            ],
          },
        ],
      }),
    /fault schedules must be unique/,
  );
});
