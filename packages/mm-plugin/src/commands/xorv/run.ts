import {
  type CommandIO,
  type InputSchema,
  PluginCommand,
  schemaToArgs,
  schemaToFlags,
} from "@metamask/agent-wallet/plugin";
import { parseChainId, parseMaxUsd, parseTimeoutSeconds } from "../../lib/config.js";
import { runJob, type RunResult } from "../../lib/flows.js";
import { brokerFor, executorOf, hostCall, publicClientOf, reporterFor, walletStateOf } from "../../lib/host.js";
import {
  adapterField,
  brokerField,
  chainIdField,
  fromField,
  maxField,
  promptField,
  timeoutField,
  titleField,
} from "../../lib/inputs.js";

const inputs = {
  prompt: promptField,
  adapter: adapterField,
  max: maxField,
  "chain-id": chainIdField,
  timeout: timeoutField,
  title: titleField,
  from: fromField,
  broker: brokerField,
} satisfies InputSchema;

/**
 * `mm xorv run "<task>"` — buy one AI job and wait for the answer.
 *
 * Quote → vet → 402 → MetaMask signs the USDC `TransferWithAuthorization`
 * (EIP-712, via `ctx.walletExecutor`, so Guard Mode policy and 2FA apply) →
 * the broker's facilitator settles it on Monad, buyer → provider → the job runs
 * on the provider's machine → the answer, the settlement link and the ledger
 * receipt come back.
 *
 * Capabilities: `wallet-read` (which address pays, its USDC balance) and
 * `wallet-submit` (the signature). The wallet never sends a transaction: the
 * payment is a signed authorization, and the facilitator pays the gas.
 */
export default class XorvRun extends PluginCommand<RunResult> {
  static override description =
    "Run an AI job on Xorv and pay the provider in USDC over x402 on Monad, signed by your MetaMask wallet.";

  static override examples = [
    '<%= config.bin %> xorv run "Explain EIP-3009 in two paragraphs"',
    '<%= config.bin %> xorv run --prompt "Refactor this function: …" --adapter codex --max 0.10',
    '<%= config.bin %> xorv run "Write a limerick about parallel execution" --json',
  ];

  static override flags = schemaToFlags(inputs);
  static override args = schemaToArgs(inputs);

  /** Must match package.json#mm.commands[].id. */
  protected readonly pluginCommandId = "xorv:run";

  async execute(io: CommandIO): Promise<RunResult> {
    return hostCall(async () => {
      const resolved = await io.resolveInputs(inputs);
      return runJob(
        {
          broker: brokerFor(resolved.broker),
          executor: executorOf(this.ctx, io, this.pluginCommandId),
          walletState: walletStateOf(this.ctx),
          publicClient: publicClientOf(this.ctx),
          reporter: reporterFor(io),
          signal: io.signal,
        },
        {
          prompt: resolved.prompt,
          adapter: resolved.adapter,
          maxPriceUsdMicros: parseMaxUsd(resolved.max),
          chainId: parseChainId(resolved["chain-id"]),
          timeoutSeconds: parseTimeoutSeconds(resolved.timeout),
          title: resolved.title,
          from: resolved.from,
        },
      );
    });
  }

  override successHint(data: RunResult): string {
    return `Paid ${data.price} to ${data.provider.label}: ${data.payment.explorerUrl ?? "settled"}. Rate it: ${data.rate}`;
  }
}
