import { createInterface } from "node:readline";

import { parseStrictJson } from "../strict-json.js";
import { DriverToolError } from "../errors.js";
import { isJsonValue } from "../canonical.js";
import type {
  CandidateStartMessage,
  JsonValue,
  RunnerResultMessage,
} from "../types.js";

export interface DriverContext {
  scenarioId: string;
  task: JsonValue;
  availableTools: string[];
  call(tool: string, argumentsValue: JsonValue): Promise<JsonValue>;
}

export type DriverHandler = (context: DriverContext) => Promise<JsonValue>;

interface PendingCall {
  resolve(value: JsonValue): void;
  reject(error: Error): void;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function isStartMessage(value: unknown): value is CandidateStartMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.v === 1 &&
    record.type === "start" &&
    typeof record.scenarioId === "string" &&
    isJsonValue(record.task) &&
    Array.isArray(record.tools) &&
    record.tools.every((tool) => typeof tool === "string")
  );
}

function isResultMessage(value: unknown): value is RunnerResultMessage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    record.v !== 1 ||
    record.type !== "result" ||
    typeof record.id !== "string" ||
    typeof record.ok !== "boolean"
  ) {
    return false;
  }
  if (record.ok) {
    return isJsonValue(record.content);
  }
  return (
    record.error !== null &&
    typeof record.error === "object" &&
    !Array.isArray(record.error) &&
    typeof (record.error as Record<string, unknown>).code === "string" &&
    typeof (record.error as Record<string, unknown>).message === "string"
  );
}

export function runDriverAgent(handler: DriverHandler): void {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Map<string, PendingCall>();
  let sequence = 0;
  let started = false;
  let finished = false;

  const failProcess = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`candidate failed: ${message}\n`);
    process.exitCode = 1;
    if (!finished) {
      finished = true;
      send({
        v: 1,
        type: "done",
        output: { status: "candidate_error", message },
      });
    }
    input.close();
    process.stdin.pause();
  };

  input.on("line", (line) => {
    let message: unknown;
    try {
      message = parseStrictJson(line);
    } catch (error) {
      failProcess(error);
      return;
    }

    if (isStartMessage(message)) {
      if (started) {
        failProcess(new Error("received more than one start message"));
        return;
      }
      started = true;
      const context: DriverContext = {
        scenarioId: message.scenarioId,
        task: message.task,
        availableTools: [...message.tools],
        call(tool: string, argumentsValue: JsonValue): Promise<JsonValue> {
          if (!isJsonValue(argumentsValue)) {
            return Promise.reject(new Error("tool arguments must be JSON"));
          }
          sequence += 1;
          const id = `call-${sequence}`;
          return new Promise<JsonValue>((resolve, reject) => {
            pending.set(id, { resolve, reject });
            send({
              v: 1,
              type: "call",
              id,
              tool,
              arguments: argumentsValue,
            });
          });
        },
      };

      void handler(context)
        .then((output) => {
          if (!isJsonValue(output)) {
            throw new Error("candidate output must be JSON");
          }
          if (pending.size > 0) {
            throw new Error("candidate completed with unresolved tool calls");
          }
          finished = true;
          send({ v: 1, type: "done", output });
          input.close();
          process.stdin.pause();
        })
        .catch(failProcess);
      return;
    }

    if (isResultMessage(message)) {
      const call = pending.get(message.id);
      if (call === undefined) {
        failProcess(new Error(`received result for unknown call ${message.id}`));
        return;
      }
      pending.delete(message.id);
      if (message.ok) {
        call.resolve(message.content as JsonValue);
      } else {
        const detail = message.error;
        call.reject(
          new DriverToolError(
            detail?.code ?? "tool_error",
            detail?.message ?? "tool call failed",
          ),
        );
      }
      return;
    }

    failProcess(new Error("received an invalid driver message"));
  });

  input.on("close", () => {
    if (!finished && process.exitCode === undefined) {
      process.exitCode = 1;
    }
  });
}
