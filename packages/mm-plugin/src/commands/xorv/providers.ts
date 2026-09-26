import {
  type CommandIO,
  InputFieldType,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { listProviders, type ProvidersResult } from "../../lib/flows.js";
import { brokerFor, hostCall } from "../../lib/host.js";
import { adapterField, brokerField } from "../../lib/inputs.js";

const inputs = {
  adapter: adapterField,
  all: {
    type: InputFieldType.Boolean,
    flag: "all",
    message: "Include offline providers",
    required: false,
    prompt: false,
    default: false,
  },
  broker: brokerField,
} satisfies InputSchema;

/**
 * `mm xorv providers` — who is selling AI capacity right now, at what price,
 * and how they have done: completed/failed jobs, buyer ratings, and the
 * provider's ERC-8004 agent identity on Monad.
 *
 * Read-only, and it touches no wallet, so it declares no capabilities and
 * runs without sign-in.
 */
export default class XorvProviders extends PluginCommand<ProvidersResult> {
  static override description = "List live Xorv providers: agent, price per job, ERC-8004 agent id and reputation.";

  static override examples = [
    "<%= config.bin %> xorv providers",
    "<%= config.bin %> xorv providers --adapter claude-code",
    "<%= config.bin %> xorv providers --broker https://broker.xorv.dev --json",
  ];

  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  /** Must match package.json#mm.commands[].id. */
  protected readonly pluginCommandId = "xorv:providers";

  async execute(io: CommandIO): Promise<ProvidersResult> {
    return hostCall(async () => {
      const { adapter, all, broker } = await io.resolveInputs(inputs);
      return listProviders(brokerFor(broker), { adapter, all });
    });
  }

  override successHint(data: ProvidersResult): string {
    if (data.count === 0) return `No providers online at ${data.broker}.`;
    const cheapest = data.providers[0];
    return `${data.count} provider${data.count === 1 ? "" : "s"} online; cheapest ${cheapest?.from ?? "?"} (${cheapest?.label}). Next: mm xorv quote "<task>"`;
  }
}
