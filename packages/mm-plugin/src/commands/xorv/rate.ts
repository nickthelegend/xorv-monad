import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { parseStars } from "../../lib/config.js";
import { rate } from "../../lib/flows.js";
import { brokerFor, executorOf, hostCall, reporterFor, walletStateOf } from "../../lib/host.js";
import { brokerField, fromField, jobIdField } from "../../lib/inputs.js";
import type { RateResult } from "../../lib/rate.js";

const inputs = {
  "job-id": jobIdField,
  stars: {
    type: InputFieldType.Text,
    flag: "stars",
    message: "Your rating, 1 (poor) to 5 (excellent)",
    required: false,
    prompt: true,
  },
  from: fromField,
  broker: brokerField,
} satisfies InputSchema;

/**
 * `mm xorv rate <jobId> --stars 1-5` — rate a job you paid for.
 *
 * MetaMask signs XorvLedger's EIP-712 `Rating` (no transaction, no gas); the
 * broker relays it to `XorvLedger.rateJob`, which verifies the signer is the
 * job's payer and records ERC-8004 reputation feedback for the provider's
 * agent. The plugin rebuilds and checks the typed data before signing.
 */
export default class XorvRate extends PluginCommand<RateResult> {
  static override description = "Rate a paid Xorv job 1-5 stars: a gasless EIP-712 signature that becomes ERC-8004 reputation.";

  static override examples = [
    "<%= config.bin %> xorv rate job_Ab3dEf9h --stars 5",
    "<%= config.bin %> xorv rate --job-id job_Ab3dEf9h --stars 2 --json",
  ];

  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  /** Must match package.json#mm.commands[].id. */
  protected readonly pluginCommandId = "xorv:rate";

  async execute(io: CommandIO): Promise<RateResult> {
    return hostCall(async () => {
      const resolved = await io.resolveInputs(inputs);
      const { stars, value } = parseStars(resolved.stars);
      return rate(
        {
          broker: brokerFor(resolved.broker),
          executor: executorOf(this.ctx, io, this.pluginCommandId),
          walletState: walletStateOf(this.ctx),
          reporter: reporterFor(io),
          signal: io.signal,
        },
        { jobId: resolved["job-id"], stars, value, from: resolved.from },
      );
    });
  }

  override successHint(data: RateResult): string {
    return `Rated job ${data.jobId} ${data.stars}/5 for ERC-8004 agent #${data.agentId}: ${data.explorerUrl}`;
  }
}
