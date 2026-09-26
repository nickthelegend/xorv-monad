/**
 * Input fields shared by the `mm xorv` commands, declared once in the host's
 * input schema so they become oclif flags, positionals and (in the REPL)
 * prompts. Optional fields set `prompt: false`: in `mm`'s input engine a field
 * without an explicit `index` that may prompt also consumes a leftover
 * positional, which would let `--broker` swallow the prompt text.
 *
 * Nothing is marked `required`: the host turns `required` into a mandatory
 * oclif argument or flag, checked before the input engine can prompt for it.
 * The flows validate presence themselves, with a hint.
 */

import { InputFieldType } from "@metamask/agent-wallet/plugin";
import { BROKER_URL_ENV, DEFAULT_BROKER_URL, DEFAULT_MAX_USD, DEFAULT_TIMEOUT_SECONDS } from "./config.js";

export const brokerField = {
  type: InputFieldType.Text,
  flag: "broker",
  env: BROKER_URL_ENV,
  message: `Xorv broker URL (default ${DEFAULT_BROKER_URL}; env ${BROKER_URL_ENV})`,
  required: false,
  prompt: false,
} as const;

export const promptField = {
  type: InputFieldType.Text,
  flag: "prompt",
  message: "The task for the AI provider, as a complete, self-contained prompt",
  // Not `required`: that would make the oclif positional mandatory and reject
  // the `--prompt "…"` spelling. A missing prompt is prompted for in the REPL
  // and refused with XORV_INVALID_INPUT otherwise.
  required: false,
  index: 0,
} as const;

export const adapterField = {
  type: InputFieldType.Text,
  flag: "adapter",
  message: "Preferred agent, e.g. claude-code, codex, qwen, kimi (default: the broker picks)",
  required: false,
  prompt: false,
} as const;

export const maxField = {
  type: InputFieldType.Text,
  flag: "max",
  message: `Most you will pay for this job, in US dollars (default ${DEFAULT_MAX_USD})`,
  required: false,
  prompt: false,
} as const;

export const chainIdField = {
  type: InputFieldType.Text,
  flag: "chain-id",
  message: "Only pay if the broker quotes on this chain: 10143 (Monad testnet) or 143 (Monad mainnet)",
  required: false,
  prompt: false,
} as const;

export const timeoutField = {
  type: InputFieldType.Text,
  flag: "timeout",
  message: `Seconds to wait for the job to finish (default ${DEFAULT_TIMEOUT_SECONDS})`,
  required: false,
  prompt: false,
} as const;

export const fromField = {
  type: InputFieldType.Text,
  flag: "from",
  message: "Pay/sign as this wallet address (default: the selected MetaMask wallet)",
  required: false,
  prompt: false,
} as const;

export const titleField = {
  type: InputFieldType.Text,
  flag: "title",
  message: "Optional label to find the job again on the job board",
  required: false,
  prompt: false,
} as const;

export const jobIdField = {
  type: InputFieldType.Text,
  flag: "job-id",
  message: "The job id printed by mm xorv run",
  // Optional for the same reason as the prompt: `--job-id` must work too.
  required: false,
  index: 0,
} as const;
