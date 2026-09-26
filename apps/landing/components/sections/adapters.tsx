import { Claude, Codex, Grok, Hunyuan, Kimi, OpenAI, OpenCode, Qwen } from "@lobehub/icons";
import { Reveal } from "@/components/ui/reveal";
import { Section, SectionHeading } from "@/components/ui/kit";

/**
 * What a node can sell.
 *
 * A table, because this is reference material — ten rows with the same three
 * facts each. Ten cards would take four times the space to say the same thing
 * and would imply a hierarchy that isn't there.
 *
 * The marks are the monochrome ones the app's model picker uses: `.Color`
 * variants at full saturation in a black page would read as a sponsor wall.
 */
const MARKS: Record<string, React.ReactNode> = {
  "claude-code": <Claude size={16} />,
  codex: <Codex size={16} />,
  grok: <Grok size={16} />,
  opencode: <OpenCode size={16} />,
  qwen: <Qwen size={16} />,
  "qwen-code": <Qwen size={16} />,
  kimi: <Kimi size={16} />,
  hunyuan: <Hunyuan size={16} />,
  "openai-compatible": <OpenAI size={16} />,
};

const ADAPTERS = [
  {
    name: "Claude Code",
    id: "claude-code",
    reports: "Tool calls, file edits, extended thinking",
    live: true,
  },
  { name: "Codex", id: "codex", reports: "Shell commands, file changes", live: true },
  { name: "Qwen Code", id: "qwen-code", reports: "Tool calls, file edits — driving Qwen 3.8 Max", live: true },
  { name: "Qwen 3.8 Max", id: "qwen", reports: "Reasoning, answer, token cost", live: true },
  { name: "Kimi K3", id: "kimi", reports: "Reasoning, answer, token cost", live: true },
  { name: "Hunyuan hy4", id: "hunyuan", reports: "Answer, token cost", live: true },
  { name: "Grok Code", id: "grok", reports: "Answer and reasoning", live: true },
  { name: "OpenCode", id: "opencode", reports: "Answer", live: true },
  {
    name: "OpenAI-compatible",
    id: "openai-compatible",
    reports: "Answer — Ollama, LM Studio, vLLM, OpenRouter",
    live: true,
  },
  { name: "Echo", id: "echo", reports: "Built in — exercises the payment path", live: false },
];

export function Adapters() {
  return (
    <Section id="adapters" className="border-t border-[var(--line)]">
      <Reveal>
        <SectionHeading
          title="Sell whatever you've already got"
          sub="An adapter drives a CLI you have installed and signed in, or streams from a model API with your own key. Writing a new one is a class with two methods."
        />
      </Reveal>

      <Reveal delay={0.06}>
        <div className="mx-auto mt-14 max-w-3xl overflow-x-auto">
          <table className="w-full min-w-[34rem] text-left">
            <thead>
              <tr className="border-b border-[var(--line)]">
                <th scope="col" className="pb-3 text-[12px] font-medium text-fg-4">
                  Adapter
                </th>
                <th scope="col" className="pb-3 text-[12px] font-medium text-fg-4">
                  Identifier
                </th>
                <th scope="col" className="pb-3 text-[12px] font-medium text-fg-4">
                  Streams back
                </th>
              </tr>
            </thead>
            <tbody>
              {ADAPTERS.map((adapter) => (
                <tr
                  key={adapter.id}
                  className="border-b border-[var(--line)] transition-colors hover:bg-white/[0.02]"
                >
                  <td className="py-4 pr-6 align-top">
                    <span className="inline-flex items-center gap-2.5">
                      <span aria-hidden className="flex h-4 w-4 shrink-0 items-center justify-center text-fg-2">
                        {MARKS[adapter.id] ?? null}
                      </span>
                      <span className="text-[14.5px] font-medium text-fg">{adapter.name}</span>
                    </span>
                    {!adapter.live ? (
                      <span className="ml-2 text-[11px] text-fg-4">test</span>
                    ) : null}
                  </td>
                  <td className="mono py-4 pr-6 align-top text-[12.5px] text-fg-3">{adapter.id}</td>
                  <td className="py-4 align-top text-[13.5px] leading-relaxed text-fg-2">
                    {adapter.reports}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <p className="measure mx-auto mt-10 text-center text-[13.5px] leading-relaxed text-fg-3">
          Qwen 3.8 Max, Kimi K3 and Hunyuan run in-process with no tools — there is no child process
          for a hostile prompt to steer, and their keys never enter a job&rsquo;s environment.
          Grok&rsquo;s headless mode reports no tool steps, so Xorv claims none.
        </p>
      </Reveal>
    </Section>
  );
}
