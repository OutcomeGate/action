import { createInterface } from "node:readline";

export class DriverToolError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "DriverToolError";
    this.code = code;
  }
}
function isJsonValue(value) {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  return (
    typeof value === "object" &&
    Object.values(value).every(isJsonValue)
  );
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

export function runDriverAgent(handler) {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  const pending = new Map();
  let sequence = 0;
  let started = false;
  let finished = false;

  const fail = (error) => {
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
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      fail(error);
      return;
    }

    if (
      message?.v === 1 &&
      message.type === "start" &&
      typeof message.scenarioId === "string" &&
      isJsonValue(message.task) &&
      Array.isArray(message.tools)
    ) {
      if (started) {
        fail(new Error("received more than one start message"));
        return;
      }
      started = true;
      const context = {
        scenarioId: message.scenarioId,
        task: message.task,
        availableTools: [...message.tools],
        call(tool, argumentsValue) {
          if (!isJsonValue(argumentsValue)) {
            return Promise.reject(new Error("tool arguments must be JSON"));
          }
          sequence += 1;
          const id = `call-${sequence}`;
          return new Promise((resolve, reject) => {
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
        .catch(fail);
      return;
    }

    if (
      message?.v === 1 &&
      message.type === "result" &&
      typeof message.id === "string" &&
      typeof message.ok === "boolean"
    ) {
      const call = pending.get(message.id);
      if (call === undefined) {
        fail(new Error(`received result for unknown call ${message.id}`));
        return;
      }
      pending.delete(message.id);
      if (message.ok && isJsonValue(message.content)) {
        call.resolve(message.content);
      } else if (
        !message.ok &&
        typeof message.error?.code === "string" &&
        typeof message.error?.message === "string"
      ) {
        call.reject(
          new DriverToolError(message.error.code, message.error.message),
        );
      } else {
        fail(new Error("received an invalid tool result"));
      }
      return;
    }

    fail(new Error("received an invalid driver message"));
  });
}
