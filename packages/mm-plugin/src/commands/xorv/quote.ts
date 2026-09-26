import {
  type CommandIO,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { parseChainId, parseMaxUsd } from "../../lib/config.js";
import { getQuote, type QuoteResult } from "../../lib/flows.js";
import { brokerFor, hostCall } from "../../lib/host.js";
import { adapterField, brokerField, chainIdField, maxField, promptField } from "../../lib/inputs.js";

const inputs = {
  prompt: promptField,
  adapter: adapterField,
  max: maxField,
  "chain-id": chainIdField,
  broker: brokerField,
} satisfies InputSchema;

/**
 * `mm xorv quote "<task>"` — what running this task would cost, and who would
 * run it, without paying.
 *
 * The broker freezes a single-use, five-minute quote: provider, price, and the
 * exact USDC amount the x402 payment will ask for, payable straight to the
 * provider. The plugin vets it the same way `run` does before signing (chain,
 * ceiling, amount and payee consistency), so a quote that `run` would refuse is
 * refused here too. No wallet access; no capabilities.
 */
export default class XorvQuote extends PluginCommand<QuoteResult> {
  static override description = "Price an AI job on Xorv without paying: provider, agent, USDC amount and payee.";

  static override examples = [
    '<%= config.bin %> xorv quote "Summarise RFC 9110 in five bullet points"',
    '<%= config.bin %> xorv quote --prompt "Write a haiku about Monad" --adapter claude-code --max 0.02',
  ];

  static override requiresAuth = false;
  static override requiresInit = false;
  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  /** Must match package.json#mm.commands[].id. */
  protected readonly pluginCommandId = "xorv:quote";

  async execute(io: CommandIO): Promise<QuoteResult> {
    return hostCall(async () => {
      const resolved = await io.resolveInputs(inputs);
      return getQuote(brokerFor(resolved.broker), {
        prompt: resolved.prompt,
        adapter: resolved.adapter,
        maxPriceUsdMicros: parseMaxUsd(resolved.max),
        chainId: parseChainId(resolved["chain-id"]),
      });
    });
  }

  override successHint(data: QuoteResult): string {
    return (
      `${data.price} (${data.usdc}) to ${data.provider.label} via ${data.provider.adapter}, ` +
      `valid ${data.expiresInSeconds}s. Pay and run it with: mm xorv run "<same task>" --max ${data.max.replace(/^\$/, "")}`
    );
  }
}
