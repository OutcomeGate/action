# Manifest-backed adapter API v2

An Agent CI adapter is a synthetic state machine and tool boundary. It defines
which tools a candidate may call, validates the suite's state contract, creates
a fresh environment for each scenario, and returns detached JSON snapshots for
evidence.

The preferred v0.3 path is an `agentci.adapter-manifest.v1` declaration backed
by an `agentci.adapter.v2` Node ESM module. Legacy in-process API-v1 adapters
remain compatibility-only and are not the GitHub Action path.

## Adapter manifest

```json
{
  "schemaVersion": "agentci.adapter-manifest.v1",
  "id": "counter.v1",
  "version": "2.0.0",
  "runtime": {
    "kind": "node-esm",
    "apiVersion": "agentci.adapter.v2",
    "protocolVersion": 1,
    "entry": "adapter.mjs",
    "operationTimeoutMs": 1000,
    "shutdownTimeoutMs": 250
  },
  "bundle": { "root": "adapter.bundle" },
  "contract": { "tools": ["counter.increment"] },
  "target": {
    "kind": "synthetic",
    "reason": "Self-contained counter state",
    "configuration": { "namespace": "counter-example" }
  },
  "credentials": { "environment": [] }
}
```

The manifest path rules and bundle-capture limits are the same as for a
candidate release: normalized relative POSIX paths, regular files only, no
symlinks or hard links, stable double capture, at most 1,000 files and 20 MiB.
Every file in `bundle.root` contributes to the adapter identity.

Important field constraints:

- `id` matches `^[a-z0-9][a-z0-9._-]*$` and must equal the suite's `fixture`.
- `operationTimeoutMs` is 100 through 60,000.
- `shutdownTimeoutMs` is 100 through 10,000.
- `contract.tools` is a non-empty, unique list. The module descriptor and every
  created environment must expose the exact same ordered list.
- A synthetic target contains a non-empty `reason`, JSON-object
  `configuration`, and no credential names.
- A remote target requires an absolute HTTPS endpoint without embedded
  credentials, query, or fragment, plus `tenant`, `apiVersion`, and JSON-object
  `configuration`.

The GitHub Action supports only a credential-free adapter, so use
`credentials.environment: []`. The local CLI has a digest-pinned exact-name
grant path for separately controlled remote-adapter evaluation, but that path
is rejected by the v0.3 Action.

## Module export

Export the adapter object as either `default` or a named `adapter`. The export
is closed: it must contain exactly these fields:

```js
export default {
  apiVersion: "agentci.adapter.v2",
  id: "counter.v1",
  version: "2.0.0",
  tools: ["counter.increment"],
  conformance: [/* one or more deterministic cases */],
  validateSuite,
  validateStatePointer,
  createEnvironment,
};
```

`apiVersion`, `id`, `version`, and `tools` must match the manifest. The adapter
module is imported in a child host process after its captured entry digest has
been checked.

The complete working example is
[`examples/counter/adapter.bundle/adapter.mjs`](../examples/counter/adapter.bundle/adapter.mjs).

## Operation context

Each function receives a frozen context:

```text
{
  signal: AbortSignal,
  scenarioId: string,
  operationId: string,
  timeoutMs: number,
  target: JSON,
  credentials: Readonly<Record<string, string>>
}
```

`target` is the normalized manifest target. In the credential-free workflow,
`credentials` is empty. The adapter host starts with only explicitly granted
credential environment variables, captures them, deletes them from
`process.env`, and supplies them through `context.credentials`.

Honor `context.signal` in every asynchronous operation. A timeout or
cancellation poisons that host; do not continue remote mutations in background
work.

## Validation functions

### `validateSuite(suite, context)`

Return an array of non-empty issue strings. Return `[]` when the suite's task,
initial-state, fault, and other adapter-specific shapes are valid. Do not throw
for an ordinary user validation error; reserve throws for an adapter execution
failure.

### `validateStatePointer(pointer, initialState, context)`

Return `undefined` when a state JSON Pointer is meaningful for this adapter and
initial state. Otherwise return one non-empty issue string. Agent CI invokes
this for every `source: "state"` JSON-pointer assertion.

The evaluator independently rejects suite faults and event assertions that
name tools outside the manifest contract, and it rejects `absent` assertions
against untyped candidate output.

## Conformance cases

Declare at least one deterministic case:

```js
conformance: [
  {
    name: "increments isolated counter state",
    initialState: { count: 0 },
    call: {
      tool: "counter.increment",
      arguments: { delta: 1 },
    },
    expectedResult: { count: 1 },
    expectedFinalState: { count: 1 },
  },
]
```

`adapter-check` creates two fresh environments. It verifies that both preserve
the initial state, snapshots are detached from internal state, the call result
and final state match the declaration, one environment cannot mutate the
other, and repeated fresh execution is deterministic. It also requires clean
closure of both environments.

Run it with:

```bash
node dist/src/cli.js adapter-check \
  --adapter-manifest path/to/adapter.manifest.json
```

## `createEnvironment`

`createEnvironment(initialState, context)` may be async. It must return an
object with exactly `tools`, `call`, `snapshot`, and `close`:

```js
function createEnvironment(initialState, context) {
  const state = structuredClone(initialState);

  return {
    tools: ["counter.increment"],

    async call(tool, argumentsValue, operation) {
      if (operation.signal.aborted) {
        throw new Error("operation aborted");
      }
      if (tool !== "counter.increment") {
        throw {
          agentciToolError: true,
          code: "unknown_tool",
          message: `unknown tool: ${tool}`,
        };
      }
      if (
        argumentsValue === null ||
        Array.isArray(argumentsValue) ||
        typeof argumentsValue !== "object" ||
        !Number.isFinite(argumentsValue.delta)
      ) {
        throw {
          agentciToolError: true,
          code: "invalid_arguments",
          message: "delta must be finite",
        };
      }
      state.count += argumentsValue.delta;
      return { count: state.count };
    },

    snapshot(operation) {
      if (operation.signal.aborted) {
        throw new Error("snapshot aborted");
      }
      return structuredClone(state);
    },

    close(_operation) {},
  };
}
```

All returned state, results, and error details must be finite plain JSON within
the host protocol limits: at most 1 MiB per IPC message, 64 levels of JSON
depth, and 100,000 JSON nodes. Snapshots must be detached: modifying a returned
snapshot must never mutate internal state.

To return an expected tool-level error to the candidate, throw an object with
`agentciToolError: true` plus non-empty `code` and `message` strings. An
unexpected exception is an adapter/evaluator integrity failure and normally
makes the scenario indeterminate.

`close` is mandatory. Release network handles, timers, and other resources
within its deadline. The evaluator may instead cancel and terminate the host
after a fault or timeout, so external operations must also use their own
idempotency and reconciliation controls.

## Transition evidence and injected faults

For each candidate call, the host snapshots before and after invoking `call`.
Agent CI records the state hashes, tool outcome, and whether the state changed.
A `before` suite fault skips the adapter call and returns the declared error. An
`after` fault invokes the adapter, captures its resulting state, and then
returns the declared error instead of the successful content. This models an
ambiguous response after a commit.

The adapter host is process-separated from the evaluator, uses sequenced IPC,
enforces per-operation deadlines, and is materialized from captured bytes.
This is an integrity boundary, not hostile-code or OS isolation. See
[Security model](SECURITY-MODEL.md).
