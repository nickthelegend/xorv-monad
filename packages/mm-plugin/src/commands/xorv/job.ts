import {
  type CommandIO,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { readJob, type JobResult } from "../../lib/flows.js";
import { brokerFor, hostCall } from "../../lib/host.js";
import { brokerField, jobIdField } from "../../lib/inputs.js";

const inputs = {
  "job-id": jobIdField,
  broker: brokerField,
} satisfies InputSchema;

/**
 * `mm xorv job <jobId>` — read a job back: status, result, payment and ledger
 * receipt. For a job that outlived `mm xorv run --timeout`, which keeps running
 * (it is paid for) after the command stops waiting. Read-only; no capabilities.
 */
export default class XorvJob extends PluginCommand<JobResult> {
  static override description = "Show a Xorv job: status, result, settlement and XorvLedger receipt.";

  static override examples = ["<%= config.bin %> xorv job job_Ab3dEf9h", "<%= config.bin %> xorv job job_Ab3dEf9h --json"];

  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  /** Must match package.json#mm.commands[].id. */
  protected readonly pluginCommandId = "xorv:job";

  async execute(io: CommandIO): Promise<JobResult> {
    return hostCall(async () => {
      const resolved = await io.resolveInputs(inputs);
      return readJob(brokerFor(resolved.broker), resolved["job-id"]);
    });
  }

  override successHint(data: JobResult): string {
    return data.status === "completed" && !data.rating
      ? `Job ${data.status}. Rate it: mm xorv rate ${data.jobId} --stars 5`
      : `Job ${data.status}.`;
  }
}
