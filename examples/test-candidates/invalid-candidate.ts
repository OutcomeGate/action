process.stdin.resume();
process.stdin.once("data", () => {
  process.stdout.write("this is not JSON\n");
});
