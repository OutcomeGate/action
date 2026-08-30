import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

import { digestValue, isJsonValue } from "../canonical.js";
import {
  assertNoKnownSecretLeaks,
  assertNoKnownSecretLeaksAtJsonBoundary,
  knownSecretsFromCredentialEnv,
  type KnownSecret,
} from "../credential-policy.js";
import { FixtureError, ToolCallError } from "../errors.js";
import { parseStrictJson } from "../strict-json.js";
import type {
  CandidateDoneMessage,
  CandidateDiagnostics,
  CandidateMessage,
  Environment,
  FaultSpec,
  JsonValue,
  RunnerResultMessage,
  ScenarioSpec,
  ToolErrorShape,
  ToolEvent,
  Verdict,
} from "../types.js";

export interface DriverRunResult {
  verdict: Verdict;
  reasons: string[];
  output?: JsonValue;
  events: ToolEvent[];
  candidateDiagnostics: CandidateDiagnostics;
  durationMs: number;
}

const STDERR_LIMIT = 16_384;
const CREDENTIAL_REDACTED_STATE_DIGEST = createHash("sha256")
  .update("agentci.redacted-known-secret-state.v1")
  .digest("hex");

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseCandidateMessage(value: unknown): CandidateMessage | undefined {
  if (!isRecord(value) || value.v !== 1 || typeof value.type !== "string") {
    return undefined;
  }
  if (
    value.type === "call" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.tool === "string" &&
    value.tool.length > 0 &&
    isJsonValue(value.arguments)
  ) {
    return {
      v: 1,
      type: "call",
      id: value.id,
      tool: value.tool,
      arguments: value.arguments,
    };
  }
  if (value.type === "done" && isJsonValue(value.output)) {
    return { v: 1, type: "done", output: value.output };
  }
  return undefined;
}

type CandidateInputMessage =
  | RunnerResultMessage
  | {
      v: 1;
      type: "start";
      scenarioId: string;
      task: JsonValue;
      tools: string[];
    };

function serializeCandidateInput(
  message: RunnerResultMessage | {
    v: 1;
    type: "start";
    scenarioId: string;
    task: JsonValue;
    tools: string[];
  },
): string {
  return `${JSON.stringify(message)}\n`;
}

function matchingFault(
  faults: FaultSpec[],
  tool: string,
  onCall: number,
): FaultSpec | undefined {
  return faults.find((fault) => fault.tool === tool && fault.onCall === onCall);
}

function expectedToolError(value: unknown): ToolErrorShape | undefined {
  if (value instanceof ToolCallError) {
    return value.detail;
  }
  if (
    value !== null &&
    typeof value === "object" &&
    (value as { agentciToolError?: unknown }).agentciToolError === true &&
    typeof (value as { code?: unknown }).code === "string" &&
    (value as { code: string }).code.length > 0 &&
    typeof (value as { message?: unknown }).message === "string" &&
    (value as { message: string }).message.length > 0
  ) {
    return {
      code: (value as { code: string }).code,
      message: (value as { message: string }).message,
    };
  }
  return undefined;
}

async function snapshotDigest(
  environment: Environment,
  knownCandidateSecrets: ReturnType<typeof knownSecretsFromCredentialEnv>,
): Promise<string> {
  const snapshot = await environment.snapshot();
  if (!isJsonValue(snapshot)) {
    throw new FixtureError("adapter snapshot was not a JSON value");
  }
  try {
    assertNoKnownSecretLeaksAtJsonBoundary(snapshot, knownCandidateSecrets);
  } catch {
    throw new FixtureError(
      "adapter state crossed the candidate credential boundary",
    );
  }
  return digestValue(snapshot);
}

export async function runCandidateProcess(options: {
  candidatePath: string;
  scenario: ScenarioSpec;
  environment: Environment;
  candidateEnvironment?: Readonly<Record<string, string>>;
  candidateCredentialNames?: readonly string[];
  knownExecutionSecrets?: readonly KnownSecret[];
  /** Values owned by another process that must not enter candidate startup. */
  protectedSecrets?: readonly KnownSecret[];
  timeoutMs?: number;
}): Promise<DriverRunResult> {
  const startedAt = Date.now();
  const { candidatePath, scenario, environment } = options;
  const timeoutMs = options.timeoutMs ?? scenario.timeoutMs;
  const candidateEnvironment: Readonly<Record<string, string>> =
    options.candidateEnvironment ?? Object.freeze({});
  const candidateCredentialEnvironment = Object.freeze(
    Object.fromEntries(
      (options.candidateCredentialNames ?? Object.keys(candidateEnvironment)).map(
        (name) => [name, candidateEnvironment[name]!],
      ),
    ),
  );
  const knownCandidateSecrets = knownSecretsFromCredentialEnv(
    candidateCredentialEnvironment,
  );
  const knownExecutionSecrets =
    options.knownExecutionSecrets ?? knownCandidateSecrets;
  try {
    assertNoKnownSecretLeaksAtJsonBoundary(
      scenario.task,
      knownCandidateSecrets,
    );
  } catch {
    throw new FixtureError(
      "scenario task crossed the candidate credential boundary",
    );
  }
  const candidateWorkingDirectory = dirname(candidatePath);
  const candidateCredentialNameSet = new Set(
    options.candidateCredentialNames ?? Object.keys(candidateEnvironment),
  );
  const nonCredentialEnvironment = Object.fromEntries(
    Object.entries(candidateEnvironment).filter(
      ([name]) => !candidateCredentialNameSet.has(name),
    ),
  );
  try {
    assertNoKnownSecretLeaksAtJsonBoundary(
      {
        executable: process.execPath,
        arguments: [candidatePath],
        cwd: candidateWorkingDirectory,
        environmentNames: Object.keys(candidateEnvironment).sort(),
        nonCredentialEnvironment,
      },
      options.protectedSecrets ?? [],
    );
  } catch {
    throw new FixtureError(
      "candidate spawn metadata crossed a known credential boundary",
    );
  }
  const child = spawn(process.execPath, [candidatePath], {
    cwd: candidateWorkingDirectory,
    env: candidateEnvironment,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events: ToolEvent[] = [];
  const reasons: string[] = [];
  const requestIds = new Set<string>();
  const toolCalls = new Map<string, number>();
  const stderrHash = createHash("sha256");
  let stderrBytes = 0;
  let output: JsonValue | undefined;
  let done = false;
  let candidateFailure = false;
  let runnerFailure: string | undefined;
  let timedOut = false;
  let activeAdapterOperation = false;
  let adapterCommitUnknown = false;
  let preserveKnownCandidateBlock = false;
  let candidateStderrSecretLeak = false;
  let candidateStdoutSecretLeak = false;
  let work = Promise.resolve();
  let forceKillTimer: NodeJS.Timeout | undefined;
  const candidateCredentialBytes = Object.values(candidateCredentialEnvironment).map(
    (value) => Buffer.from(value, "utf8"),
  );
  const longestCandidateCredential = candidateCredentialBytes.reduce(
    (maximum, value) => Math.max(maximum, value.byteLength),
    0,
  );
  let candidateCredentialStderrTail = Buffer.alloc(0);
  const protocolCredentialBytes = knownExecutionSecrets.map((secret) =>
    Buffer.from(secret.value, "utf8"),
  );
  const longestProtocolCredential = protocolCredentialBytes.reduce(
    (maximum, value) => Math.max(maximum, value.byteLength),
    0,
  );
  let candidateStdoutCredentialTail = Buffer.alloc(0);
  let candidateInputCredentialTail = Buffer.alloc(0);

  const stopCandidate = (): void => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      if (forceKillTimer === undefined) {
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
          }
        }, 250);
        forceKillTimer.unref();
      }
    }
  };

  const sendToCandidate = (message: CandidateInputMessage): void => {
    const frame = serializeCandidateInput(message);
    const jsonMessage = message as unknown as JsonValue;
    assertNoKnownSecretLeaksAtJsonBoundary(jsonMessage, knownExecutionSecrets);
    assertNoKnownSecretLeaks(frame, knownExecutionSecrets);
    environment.inspectCandidateProtocol?.(jsonMessage);
    environment.inspectCandidateProtocol?.(frame);
    const frameBytes = Buffer.from(frame, "utf8");
    const combined = Buffer.concat([
      candidateInputCredentialTail,
      frameBytes,
    ]);
    if (
      protocolCredentialBytes.some(
        (credential) => combined.indexOf(credential) !== -1,
      )
    ) {
      throw new FixtureError(
        "runner-to-candidate protocol crossed a known credential boundary",
      );
    }
    candidateInputCredentialTail = combined.subarray(
      Math.max(0, combined.byteLength - Math.max(0, longestProtocolCredential - 1)),
    );
    if (!child.stdin?.writable) {
      throw new FixtureError("candidate stdin was not writable");
    }
    child.stdin.write(frame);
  };

  child.stdout.on("data", (chunk: Buffer) => {
    if (candidateStdoutSecretLeak || protocolCredentialBytes.length === 0) {
      return;
    }
    const combined = Buffer.concat([
      candidateStdoutCredentialTail,
      Buffer.from(chunk),
    ]);
    if (
      protocolCredentialBytes.some(
        (credential) => combined.indexOf(credential) !== -1,
      )
    ) {
      candidateStdoutSecretLeak = true;
      candidateFailure = true;
      preserveKnownCandidateBlock = true;
      reasons.push("candidate stdout crossed a known credential boundary");
      if (environment.abort !== undefined) {
        void Promise.resolve(
          environment.abort("candidate stdout credential boundary violation"),
        ).catch(() => undefined);
      }
      stopCandidate();
      return;
    }
    candidateStdoutCredentialTail = combined.subarray(
      Math.max(0, combined.byteLength - Math.max(0, longestProtocolCredential - 1)),
    );
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

  child.stderr.on("data", (chunk: Buffer) => {
    stderrHash.update(chunk);
    stderrBytes += chunk.byteLength;
    if (!candidateStderrSecretLeak) {
      try {
        const combined = Buffer.concat([
          candidateCredentialStderrTail,
          chunk,
        ]);
        if (
          candidateCredentialBytes.some(
            (credential) => combined.indexOf(credential) !== -1,
          )
        ) {
          throw new Error("known candidate credential detected");
        }
        candidateCredentialStderrTail = combined.subarray(
          Math.max(
            0,
            combined.byteLength - Math.max(0, longestCandidateCredential - 1),
          ),
        );
        environment.inspectCandidateStderr?.(chunk);
      } catch {
        candidateStderrSecretLeak = true;
        candidateFailure = true;
        preserveKnownCandidateBlock = true;
        reasons.push(
          "candidate stderr crossed a known credential boundary",
        );
        if (environment.abort !== undefined) {
          void Promise.resolve(
            environment.abort("candidate stderr credential boundary violation"),
          ).catch(() => undefined);
        }
        stopCandidate();
      }
    }
  });

  child.stdin?.on("error", (error) => {
    if (!done && runnerFailure === undefined) {
      candidateFailure = true;
      reasons.push(`candidate stdin failed: ${error.message}`);
      stopCandidate();
    }
  });

  const handleToolCall = async (
    message: Extract<CandidateMessage, { type: "call" }>,
  ): Promise<void> => {
    if (done) {
      candidateFailure = true;
      reasons.push("candidate sent a tool call after done");
      stopCandidate();
      return;
    }
    if (requestIds.has(message.id)) {
      candidateFailure = true;
      reasons.push(`candidate reused request id ${message.id}`);
      stopCandidate();
      return;
    }
    requestIds.add(message.id);

    if (events.length >= scenario.maxToolCalls) {
      candidateFailure = true;
      reasons.push(`candidate exceeded the ${scenario.maxToolCalls}-call budget`);
      sendToCandidate({
        v: 1,
        type: "result",
        id: message.id,
        ok: false,
        error: {
          code: "tool_call_budget_exceeded",
          message: "scenario tool-call budget exceeded",
        },
      });
      stopCandidate();
      return;
    }

    const currentToolCall = (toolCalls.get(message.tool) ?? 0) + 1;
    toolCalls.set(message.tool, currentToolCall);
    const eventStartedAt = Date.now();
    const fault = matchingFault(scenario.faults, message.tool, currentToolCall);
    let appliedFault: FaultSpec | undefined;
    let content: JsonValue | undefined;
    let error: ToolErrorShape | undefined;
    let beforeStateHash = CREDENTIAL_REDACTED_STATE_DIGEST;
    let afterStateHash = CREDENTIAL_REDACTED_STATE_DIGEST;

    const unknownTool = !environment.tools.includes(message.tool);
    if (unknownTool) {
      error = { code: "unknown_tool", message: `unknown tool: ${message.tool}` };
      candidateFailure = true;
      preserveKnownCandidateBlock = true;
      reasons.push(`candidate called unknown tool ${message.tool}`);
    } else if (fault?.phase === "before") {
      error = fault.error;
      appliedFault = fault;
    }

    if (environment.transition !== undefined) {
      const invoke = !unknownTool && fault?.phase !== "before";
      activeAdapterOperation = true;
      try {
        const transition = await environment.transition(
          invoke
            ? {
                invoke: true,
                tool: message.tool,
                arguments: message.arguments,
              }
            : { invoke: false },
        );
        if (
          !isJsonValue(transition.beforeState) ||
          !isJsonValue(transition.afterState)
        ) {
          runnerFailure = "adapter transition returned a non-JSON state";
        }
        if (runnerFailure === undefined) {
          try {
            assertNoKnownSecretLeaksAtJsonBoundary(
              transition.beforeState,
              knownCandidateSecrets,
            );
            assertNoKnownSecretLeaksAtJsonBoundary(
              transition.afterState,
              knownCandidateSecrets,
            );
            beforeStateHash = digestValue(transition.beforeState);
            afterStateHash = digestValue(transition.afterState);
          } catch {
            runnerFailure =
              "adapter state crossed the candidate credential boundary";
          }
        }
        if (!invoke) {
          if (transition.outcome.kind !== "skipped") {
            runnerFailure = "adapter executed a skipped transition";
          }
          if (beforeStateHash !== afterStateHash) {
            const issue = "adapter mutated state during a skipped transition";
            if (preserveKnownCandidateBlock) {
              reasons.push(
                `adapter integrity concern after candidate block: ${issue}`,
              );
            } else {
              runnerFailure = issue;
            }
          }
        } else if (transition.outcome.kind === "ok") {
          if (!isJsonValue(transition.outcome.content)) {
            runnerFailure = "adapter transition returned non-JSON tool content";
          } else {
            content = transition.outcome.content;
          }
        } else if (transition.outcome.kind === "tool_error") {
          if (
            typeof transition.outcome.error?.code !== "string" ||
            transition.outcome.error.code.length === 0 ||
            typeof transition.outcome.error.message !== "string" ||
            transition.outcome.error.message.length === 0
          ) {
            runnerFailure = "adapter transition returned an invalid tool error";
          } else {
            error = transition.outcome.error;
          }
        } else {
          runnerFailure = "adapter skipped an invoked transition";
        }
      } finally {
        activeAdapterOperation = false;
      }
      if (
        fault?.phase === "after" &&
        content !== undefined &&
        runnerFailure === undefined
      ) {
        error = fault.error;
        content = undefined;
        appliedFault = fault;
      }
    } else {
      beforeStateHash = await snapshotDigest(environment, knownCandidateSecrets);
      if (!unknownTool && fault?.phase !== "before") {
      let fixtureCallSucceeded = false;
      try {
        const returned = await environment.call(message.tool, message.arguments);
        if (!isJsonValue(returned)) {
          runnerFailure = "adapter tool returned a non-JSON value";
        } else {
          content = returned;
          fixtureCallSucceeded = true;
        }
      } catch (caught) {
        const expected = expectedToolError(caught);
        if (expected !== undefined) {
          error = expected;
        } else if (caught instanceof FixtureError) {
          runnerFailure = caught.message;
        } else {
          runnerFailure = `fixture threw unexpectedly: ${
            caught instanceof Error ? caught.message : String(caught)
          }`;
        }
      }
      if (
        fault?.phase === "after" &&
        fixtureCallSucceeded &&
        runnerFailure === undefined
      ) {
        error = fault.error;
        content = undefined;
        appliedFault = fault;
      }
      }
      afterStateHash = await snapshotDigest(environment, knownCandidateSecrets);
    }

    if (runnerFailure === undefined) {
      try {
        if (content !== undefined) {
          assertNoKnownSecretLeaksAtJsonBoundary(
            content,
            knownCandidateSecrets,
          );
        }
        if (error !== undefined) {
          assertNoKnownSecretLeaksAtJsonBoundary(
            { code: error.code, message: error.message },
            knownCandidateSecrets,
          );
        }
      } catch {
        content = undefined;
        error = {
          code: "credential_boundary_violation",
          message: "adapter result crossed the candidate credential boundary",
        };
        runnerFailure =
          "adapter result crossed the candidate credential boundary";
      }
    }

    const event: ToolEvent = {
      sequence: events.length + 1,
      requestId: message.id,
      tool: message.tool,
      arguments: message.arguments,
      outcome: error === undefined ? "ok" : "error",
      ...(content !== undefined ? { content } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(appliedFault !== undefined ? { fault: appliedFault } : {}),
      committed: beforeStateHash !== afterStateHash,
      beforeStateHash,
      afterStateHash,
      durationMs: Date.now() - eventStartedAt,
    };
    events.push(event);

    if (runnerFailure !== undefined) {
      stopCandidate();
      return;
    }

    sendToCandidate({
      v: 1,
      type: "result",
      id: message.id,
      ok: error === undefined,
      ...(content !== undefined ? { content } : {}),
      ...(error !== undefined ? { error } : {}),
    });
  };

  const handleLine = async (line: string): Promise<void> => {
    if (candidateStdoutSecretLeak) {
      return;
    }
    try {
      assertNoKnownSecretLeaks(`${line}\n`, knownExecutionSecrets);
      assertNoKnownSecretLeaks(`${line}\r\n`, knownExecutionSecrets);
      environment.inspectCandidateProtocol?.(`${line}\n`);
      environment.inspectCandidateProtocol?.(`${line}\r\n`);
    } catch {
      candidateFailure = true;
      preserveKnownCandidateBlock = true;
      reasons.push(
        "candidate stdout protocol crossed a known credential boundary",
      );
      if (environment.abort !== undefined) {
        void Promise.resolve(
          environment.abort("candidate stdout credential boundary violation"),
        ).catch(() => undefined);
      }
      stopCandidate();
      return;
    }
    let raw: unknown;
    try {
      raw = parseStrictJson(line);
    } catch {
      candidateFailure = true;
      reasons.push("candidate wrote non-JSON or ambiguous JSON data to stdout");
      stopCandidate();
      return;
    }
    try {
      if (isJsonValue(raw)) {
        assertNoKnownSecretLeaksAtJsonBoundary(raw, knownExecutionSecrets);
      }
    } catch {
      candidateFailure = true;
      preserveKnownCandidateBlock = true;
      reasons.push("candidate protocol crossed its credential boundary");
      if (environment.abort !== undefined) {
        void Promise.resolve(
          environment.abort("candidate protocol credential boundary violation"),
        ).catch(() => undefined);
      }
      stopCandidate();
      return;
    }
    if (isJsonValue(raw) && environment.inspectCandidateProtocol !== undefined) {
      try {
        environment.inspectCandidateProtocol(raw);
      } catch {
        candidateFailure = true;
        preserveKnownCandidateBlock = true;
        reasons.push(
          "candidate protocol crossed the known adapter-credential boundary",
        );
        if (environment.abort !== undefined) {
          void Promise.resolve(
            environment.abort("candidate protocol credential boundary violation"),
          ).catch(() => undefined);
        }
        stopCandidate();
        return;
      }
    }
    const message = parseCandidateMessage(raw);
    if (message === undefined) {
      candidateFailure = true;
      reasons.push("candidate wrote an invalid driver-protocol message");
      stopCandidate();
      return;
    }
    if (message.type === "call") {
      await handleToolCall(message);
      return;
    }
    const doneMessage: CandidateDoneMessage = message;
    if (done) {
      candidateFailure = true;
      reasons.push("candidate sent more than one done message");
      stopCandidate();
      return;
    }
    done = true;
    output = doneMessage.output;
    child.stdin?.end();
  };

  lines.on("line", (line) => {
    work = work.then(() => handleLine(line)).catch((error: unknown) => {
      const message = `runner could not process candidate message: ${
        error instanceof Error ? error.message : String(error)
      }`;
      if (preserveKnownCandidateBlock) {
        reasons.push(`adapter integrity concern after candidate block: ${message}`);
      } else {
        runnerFailure = message;
      }
      stopCandidate();
    });
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    if (activeAdapterOperation) {
      if (candidateFailure) {
        preserveKnownCandidateBlock = true;
        reasons.push(
          "adapter transition was terminated after an independently established candidate defect",
        );
      } else {
        adapterCommitUnknown = true;
        reasons.push(
          "scenario deadline expired during an adapter transition; commit state is unknown",
        );
      }
      if (environment.abort !== undefined) {
        void Promise.resolve(
          environment.abort("scenario deadline expired during adapter transition"),
        ).catch(() => undefined);
      }
    } else {
      candidateFailure = true;
      reasons.push(`candidate timed out after ${timeoutMs}ms`);
    }
    stopCandidate();
  }, timeoutMs);

  try {
    sendToCandidate({
      v: 1,
      type: "start",
      scenarioId: scenario.id,
      task: scenario.task,
      tools: environment.tools,
    });
  } catch {
    runnerFailure =
      "runner-to-candidate protocol crossed a known credential boundary";
    stopCandidate();
  }

  type CloseResult = {
    code: number | null;
    signal: NodeJS.Signals | null;
    spawnError?: Error;
  };
  const closePromise = new Promise<CloseResult>((resolveClose) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      resolveClose({ code, signal, ...(spawnError !== undefined ? { spawnError } : {}) });
    });
  });
  let lifecycleDeadline: NodeJS.Timeout | undefined;
  const deadlinePromise = new Promise<CloseResult>((resolveDeadline) => {
    lifecycleDeadline = setTimeout(() => {
      candidateFailure = true;
      reasons.push("candidate process streams did not close within the lifecycle deadline");
      stopCandidate();
      child.stdout.destroy();
      child.stderr.destroy();
      child.stdin?.destroy();
      resolveDeadline({ code: child.exitCode, signal: child.signalCode });
    }, timeoutMs + 750);
  });
  const closeResult = await Promise.race([closePromise, deadlinePromise]);
  clearTimeout(timeout);
  if (lifecycleDeadline !== undefined) {
    clearTimeout(lifecycleDeadline);
  }
  if (forceKillTimer !== undefined) {
    clearTimeout(forceKillTimer);
  }
  let workDeadline: NodeJS.Timeout | undefined;
  const workFinished = await Promise.race([
    work.then(() => true),
    new Promise<boolean>((resolveWorkDeadline) => {
      workDeadline = setTimeout(() => resolveWorkDeadline(false), 250);
    }),
  ]);
  if (workDeadline !== undefined) {
    clearTimeout(workDeadline);
  }
  if (!workFinished) {
    if (preserveKnownCandidateBlock) {
      reasons.push(
        "adapter/tool work did not settle after the independently established candidate defect",
      );
    } else {
      runnerFailure = "fixture/tool work did not settle after candidate termination";
    }
  }
  lines.close();

  if (closeResult.spawnError !== undefined) {
    candidateFailure = true;
    reasons.push(`candidate could not start: ${closeResult.spawnError.message}`);
  }
  if (!timedOut && closeResult.signal !== null && runnerFailure === undefined) {
    candidateFailure = true;
    reasons.push(`candidate terminated by ${closeResult.signal}`);
  }
  if (!done && runnerFailure === undefined && !timedOut) {
    candidateFailure = true;
    reasons.push("candidate exited before sending done");
  }
  if (closeResult.code !== null && closeResult.code !== 0 && runnerFailure === undefined) {
    candidateFailure = true;
    reasons.push(`candidate exited with code ${closeResult.code}`);
  }

  const candidateDiagnostics: CandidateDiagnostics = {
    stderrDigest: candidateStderrSecretLeak
      ? createHash("sha256")
          .update("agentci.redacted-known-secret.v1", "utf8")
          .digest("hex")
      : stderrHash.digest("hex"),
    stderrBytes: candidateStderrSecretLeak ? 0 : stderrBytes,
    stderrTruncated: candidateStderrSecretLeak ? false : stderrBytes > STDERR_LIMIT,
  };

  if (adapterCommitUnknown && runnerFailure === undefined) {
    runnerFailure =
      "adapter transition did not complete before the scenario deadline; remote commit state may be unknown";
  }

  if (runnerFailure !== undefined) {
    return {
      verdict: "indeterminate",
      reasons: [...reasons, runnerFailure],
      ...(output !== undefined ? { output } : {}),
      events,
      candidateDiagnostics,
      durationMs: Date.now() - startedAt,
    };
  }

  return {
    verdict: candidateFailure ? "block" : "pass",
    reasons,
    ...(output !== undefined ? { output } : {}),
    events,
    candidateDiagnostics,
    durationMs: Date.now() - startedAt,
  };
}
