import { createInterface } from "node:readline";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let delta;

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message?.v === 1 && message.type === "start") {
    delta = message.task.delta;
    process.stdout.write(
      `${JSON.stringify({
        v: 1,
        type: "call",
        id: "increment-1",
        tool: "counter.increment",
        arguments: { delta },
      })}\n`,
    );
    return;
  }
  if (message?.v === 1 && message.type === "result" && message.id === "increment-1") {
    process.stdout.write(
      `${JSON.stringify({
        v: 1,
        type: "done",
        output: { requestedDelta: delta, observed: message.content },
      })}\n`,
    );
    input.close();
    process.stdin.pause();
  }
});
