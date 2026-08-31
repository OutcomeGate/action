import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const model = JSON.parse(readFileSync(new URL("./model.json", import.meta.url), "utf8"));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let decision;

function scoreText(text) {
  const tokens = new Set(text.toLowerCase().match(/[a-z]+/gu) ?? []);
  if (model.encoding === "symmetric-integer") {
    let accumulator = model.bias;
    for (const [token, weight] of Object.entries(model.weights)) {
      if (tokens.has(token)) accumulator += weight;
    }
    return accumulator * model.scale;
  }
  let score = Math.fround(model.bias);
  for (const [token, weight] of Object.entries(model.weights)) {
    if (tokens.has(token)) score = Math.fround(score + Math.fround(weight));
  }
  return score;
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message?.v === 1 && message.type === "start") {
    const score = scoreText(message.task.text);
    const route = score > 0 ? "escalate" : "auto_resolve";
    decision = { route, score, encoding: model.encoding };
    process.stdout.write(
      `${JSON.stringify({
        v: 1,
        type: "call",
        id: "route-1",
        tool: `ticket.${route}`,
        arguments: {},
      })}\n`,
    );
    return;
  }
  if (message?.v === 1 && message.type === "result" && message.id === "route-1") {
    process.stdout.write(
      `${JSON.stringify({ v: 1, type: "done", output: decision })}\n`,
    );
    input.close();
    process.stdin.pause();
  }
});
