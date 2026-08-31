# Candidate release and JSONL-v1 protocol

OutcomeGate v0.3 executes a candidate as a Node.js child process. The release-v2
manifest captures the exact entry point, bundle bytes, prompt files, tool-schema
files, model declaration, and candidate credential policy used for the check.

The GitHub Action supports only the credential-free form described here.

## Release-v2 manifest

A minimal manifest looks like this:

```json
{
  "schemaVersion": "agentci.release.v2",
  "name": "counter-agent-v1",
  "runtime": {
    "kind": "node-jsonl",
    "protocolVersion": 1,
    "entry": "candidate.mjs"
  },
  "bundle": { "root": "agent.bundle" },
  "model": {
    "kind": "none",
    "reason": "Deterministic synthetic candidate."
  },
  "components": {
    "prompts": ["prompt.md"],
    "toolSchemas": ["tool-schema.json"]
  },
  "candidate": {
    "credentials": { "kind": "none" }
  }
}
```

`bundle.root` is resolved relative to the manifest. `runtime.entry`, every
prompt path, and every tool-schema path are normalized POSIX paths relative to
the bundle root. They must refer to files in the captured bundle. Prompt paths,
tool-schema paths, and the runtime entry cannot overlap.

Every file beneath `bundle.root` is part of the release identity, including
unclassified helper code. The capture rejects traversal, symlinks, hard links,
special files, empty nested directories, unstable files, more than 1,000
files, or more than 20 MiB total. The bundle is copied to a fresh temporary
directory for each scenario and verified after execution.

The model declaration is evidence, not a model runner:

- `{"kind":"none","reason":"..."}` declares that the candidate does not
  rely on a remote model.
- `kind: "remote"` records `provider`, `identifier`, `revision`, and optional
  JSON `configuration`; the candidate itself remains responsible for any model
  call.
- Release v2 also accepts `kind: "local"` with non-empty `identifier`,
  `revision`, `format`, and `artifacts` fields plus optional JSON
  `configuration`. Every artifact path is a normalized relative path to a
  regular file inside `bundle.root`; paths are sorted, must be unique, must
  exist, and cannot overlap the runtime entry, prompts, or tool schemas.

For a local model, the manifest and model-declaration digests bind the declared
artifact paths and metadata. The bundle and release digests bind their exact
bytes, modes, and paths. This establishes which closed release was evaluated;
it does not prove that arbitrary candidate code loaded every declared artifact
or that descriptive configuration fields are truthful. The existing 1,000-file
and 20 MiB bundle limits still apply.

The v0.3 Action requires `agentci.release.v2` and an explicit
`candidate.credentials` policy. Use `{"kind":"none"}`. Although the local CLI
contains an exact-name, exact-release-digest credential grant path, the
composite Action intentionally rejects every non-empty candidate credential
input.

Validate capture before execution:

```bash
node dist/src/cli.js validate-release \
  --manifest path/to/agent.release.json
```

## Process invocation

For each scenario, OutcomeGate runs the current Node executable with the captured
entry file as its only argument. The working directory is the directory that
contains that entry file. Ambient environment variables are not copied into
the candidate process. With `candidate.credentials.kind: "none"`, its process
environment is empty.

The runner communicates through newline-delimited JSON:

- stdin: one runner message per line
- stdout: one candidate message per line
- stderr: candidate diagnostics only

Do not print logs, banners, Markdown, or partially framed JSON to stdout. A
non-JSON line, duplicate JSON object member, invalid protocol message, reused
request ID, or protocol output after completion blocks the scenario. Raw
candidate stderr is not placed in evidence; the report records only a digest,
byte count, and truncation flag.

All protocol values must be finite JSON: `null`, booleans, strings, finite
numbers, arrays, or objects composed from those values. Each candidate stdout
line is parsed with a 20 × 1024 × 1024 JavaScript-code-unit limit and a maximum
JSON nesting depth of 256.

## Message sequence

### 1. Runner sends `start`

Exactly one start message is sent to a candidate process:

```json
{
  "v": 1,
  "type": "start",
  "scenarioId": "increment-once",
  "task": { "delta": 2 },
  "tools": ["counter.increment"]
}
```

`task` comes from the suite. `tools` is the exact tool list exposed by the
scenario's adapter environment.

### 2. Candidate sends `call`

```json
{
  "v": 1,
  "type": "call",
  "id": "increment-1",
  "tool": "counter.increment",
  "arguments": { "delta": 2 }
}
```

`id` and `tool` must be non-empty strings. A request ID can be used only once
within the scenario. `arguments` must be JSON. Calling a tool not present in
the start message is a candidate defect. Every call, including a call that
returns an error, consumes the scenario's `maxToolCalls` budget.

### 3. Runner sends `result`

A successful tool call returns:

```json
{
  "v": 1,
  "type": "result",
  "id": "increment-1",
  "ok": true,
  "content": { "count": 2 }
}
```

An adapter error or injected fault returns:

```json
{
  "v": 1,
  "type": "result",
  "id": "increment-1",
  "ok": false,
  "error": {
    "code": "response_timeout",
    "message": "the operation committed but the response timed out"
  }
}
```

The result `id` matches the call. Candidates should treat an error code as part
of the declared synthetic contract, not infer rollback from receipt of an
error. An `after` fault can return an error after the adapter state has changed.

### 4. Candidate sends `done`

```json
{
  "v": 1,
  "type": "done",
  "output": {
    "requestedDelta": 2
  }
}
```

Send exactly one `done` message, after all pending calls have settled. `output`
must be JSON and is available to `source: "output"` assertions. Close cleanly
with process exit status `0`. Exiting before `done`, exiting nonzero, timing
out, or sending another call after `done` blocks the scenario.

## Minimal Node candidate

The repository's
[`candidate.mjs`](../examples/counter/releases/agent.bundle/candidate.mjs) is a
minimal implementation. A reusable driver pattern is also present in
[`driver.mjs`](../examples/refunds/releases/agent-v1.bundle/driver.mjs). Its
essential responsibilities are:

1. Parse each stdin line as JSON.
2. Accept one `start` message.
3. Generate unique call IDs and correlate `result` messages.
4. Reject malformed or unknown results.
5. Emit one JSON `done` message only after all calls settle.
6. Put diagnostics on stderr, never stdout.

The candidate protocol does not prescribe an agent framework. A Python or
other non-Node implementation currently needs a small Node entry wrapper,
because release-v2 runtime execution is fixed to `node-jsonl`.

## Scenario limits and decisions

`timeoutMs` is the primary scenario-evaluation deadline. Adapter setup,
candidate execution, and final-state capture consume that shared budget;
adapter cleanup has its own bounded deadline. `maxToolCalls` is the maximum
number of recorded candidate calls. Defaults are 2,000 ms and 20 calls when
omitted from the suite.

Candidate protocol defects, unknown tools, call-budget exhaustion, candidate
timeouts outside an active adapter transition, nonzero exits, and failed
assertions produce `BLOCK`. Adapter failures, evidence-integrity failures, or a
deadline expiring during an active adapter transition can produce
`INDETERMINATE`, because the evaluator cannot attribute a trustworthy outcome
or may not know whether a mutation committed.

See [Suites](SUITES.md) for assertions and faults and
[Troubleshooting](TROUBLESHOOTING.md) for the recommended debug order.
