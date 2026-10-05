/**
 * Entry point for the refund-keeper workflow; the logic lives in workflow.ts.
 * Only `main` is exported here: Javy, which compiles this to WASM, rejects
 * exported functions that take parameters.
 */
import { Runner } from "@chainlink/cre-sdk";
import { type Config, configSchema, initWorkflow } from "./workflow";

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
