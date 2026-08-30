import { runDriverAgent } from "../../src/driver/client.js";
import { DriverToolError } from "../../src/errors.js";

runDriverAgent(async ({ call }) => {
  try {
    await call("noop", {});
  } catch (error) {
    if (error instanceof DriverToolError) {
      return { observedCode: error.code };
    }
    throw error;
  }
  return { observedCode: "none" };
});
