process.stdin.resume();
process.on("SIGTERM", () => {
  // Exercise the runner's bounded SIGKILL fallback.
});
process.stdin.once("data", () => {
  setInterval(() => undefined, 1_000);
});
