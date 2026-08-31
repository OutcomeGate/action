# Suite, fault, and assertion reference

An `agentci.suite.v1` file declares synthetic tasks, starting state, scheduled
faults, assertions, and the aggregate gate. Runtime parsing in
[`src/suite.ts`](../src/suite.ts) is authoritative; the
[`suite.schema.json`](../schemas/suite.schema.json) file is an informative
editor aid.

## Minimal suite

```json
{
  "schemaVersion": "agentci.suite.v1",
  "name": "external-counter",
  "version": "1.0.0",
  "fixture": "counter.v1",
  "gate": { "minPassRate": 1 },
  "scenarios": [
    {
      "id": "increment-once",
      "description": "Increment the declared counter exactly once",
      "task": { "delta": 2 },
      "initialState": { "count": 0 },
      "faults": [],
      "timeoutMs": 1000,
      "maxToolCalls": 2,
      "assertions": [
        {
          "id": "final-count",
          "type": "json_pointer",
          "source": "state",
          "pointer": "/count",
          "operator": "equals",
          "expected": 2
        },
        {
          "id": "one-increment",
          "type": "event_count",
          "tool": "counter.increment",
          "outcome": "ok",
          "expected": 1
        }
      ]
    }
  ]
}
```

The repository version is
[`examples/counter/suite.json`](../examples/counter/suite.json).

## Top-level fields

| Field | Meaning |
|---|---|
| `schemaVersion` | Must be `agentci.suite.v1`. |
| `name` | Non-empty logical suite name. |
| `version` | Non-empty logical suite version. |
| `fixture` | Adapter contract ID. A custom manifest-backed adapter must have the same `id`. |
| `gate.minPassRate` | Number from `0` through `1`. In v0.3, any blocked scenario blocks the aggregate and any indeterminate scenario makes it indeterminate before this threshold is considered. |
| `scenarios` | Non-empty array with unique scenario IDs. |

Unknown fields are rejected throughout the suite structure.

## Scenario fields

| Field | Requirement |
|---|---|
| `id` | Required, non-empty, and unique in the suite. |
| `description` | Required non-empty string. |
| `task` | Required JSON value sent to the candidate in `start`. |
| `initialState` | Required JSON value supplied to a fresh adapter environment. |
| `faults` | Optional array; defaults to `[]`. |
| `assertions` | Required non-empty array with unique IDs within the scenario. |
| `timeoutMs` | Optional positive integer; defaults to `2000`. Adapter setup, candidate execution, and final-state capture consume this primary budget; cleanup is separately bounded. |
| `maxToolCalls` | Optional positive integer; defaults to `20`. Error calls count toward the budget. |

The adapter performs domain-specific validation of `task`, `initialState`, and
state assertion pointers before any scenario runs.

## Faults

```json
{
  "tool": "refunds.create",
  "onCall": 1,
  "phase": "after",
  "error": {
    "code": "response_timeout",
    "message": "the mutation committed but the response timed out"
  }
}
```

- `tool` must be exposed by the adapter.
- `onCall` is a one-based count for calls to that tool, not the global event
  sequence.
- `phase: "before"` returns the declared error without invoking the adapter.
- `phase: "after"` invokes the adapter first and, if it succeeds, hides its
  content behind the declared error. The mutation may therefore be committed.
- `error.code` and `error.message` are non-empty strings.
- A scenario cannot schedule two faults for the same `tool` and `onCall`.

Use `after` faults to exercise retry safety and reconciliation after ambiguous
commits. A process timeout while an adapter transition is still active is not a
scheduled fault; it can become `INDETERMINATE` because commit state is unknown.

## JSON-pointer assertions

Equality against final adapter state:

```json
{
  "id": "final-count",
  "type": "json_pointer",
  "source": "state",
  "pointer": "/count",
  "operator": "equals",
  "expected": 2
}
```

Absence from final state:

```json
{
  "id": "no-second-refund",
  "type": "json_pointer",
  "source": "state",
  "pointer": "/refunds/1",
  "operator": "absent"
}
```

Equality against candidate `done.output`:

```json
{
  "id": "candidate-reported-result",
  "type": "json_pointer",
  "source": "output",
  "pointer": "/action",
  "operator": "equals",
  "expected": "completed"
}
```

Pointers must be RFC 6901-style strings beginning with `/`; `~0` represents
`~` and `~1` represents `/`. Array segments are non-negative decimal indexes.
Equality uses OutcomeGate's canonical JSON representation. `absent` is not
allowed for untyped candidate output, but it is allowed for adapter state.

## Event-count assertions

```json
{
  "id": "one-increment",
  "type": "event_count",
  "tool": "counter.increment",
  "outcome": "ok",
  "expected": 1
}
```

`expected` is a non-negative integer. `outcome` is `ok`, `error`, or `any` and
defaults to `any`. Counts include recorded injected-fault results. The named
tool must be in the adapter contract.

## Event-order assertions

```json
{
  "id": "mutation-before-notification",
  "type": "event_order",
  "tools": ["refunds.create", "tickets.update", "notifications.send"]
}
```

At least two tool names are required. The assertion checks for the declared
sequence as an ordered subsequence of all recorded tool events; unrelated calls
may occur between them. Repeating a tool name requires distinct later events.
Outcomes are not filtered. Every named tool must be exposed by the adapter.

## Scenario and aggregate verdicts

A scenario is:

- `PASS` when candidate execution is sound, all assertions pass, adapter state
  lineage is intact, and cleanup succeeds.
- `BLOCK` when the evaluator establishes a candidate defect, such as a protocol
  violation, unknown tool, exceeded call budget, ordinary candidate timeout,
  or failed assertion.
- `INDETERMINATE` when configuration, adapter execution, state lineage,
  cleanup, evidence identity, or uncertain commit state prevents trustworthy
  attribution. A candidate block already established independently remains a
  block even if a later integrity concern occurs.

At the aggregate level, one or more blocked scenarios produce `BLOCK`.
Otherwise, one or more indeterminate scenarios produce `INDETERMINATE`.
Only after those checks does the evaluator compare the pass rate with
`gate.minPassRate`.

The CLI maps these decisions to exit statuses `0`, `1`, and `2`, respectively.

## Validation

```bash
node dist/src/cli.js validate \
  --suite path/to/suite.json \
  --adapter-manifest path/to/adapter.manifest.json
```

Validation parses strict JSON, applies static secret-pattern scanning, rejects
unknown fields and duplicate members, checks tool references, and asks the
adapter to validate its domain-specific state and task contract. The schemas in
[`schemas/`](../schemas/README.md) are not substitutes for this runtime check.
