import { describeTrace, formatMs, roleLabel, routingTrace } from "@/lib/ai";
import { cn } from "@/lib/utils";

/**
 * The Qwen router's agent trace: every lookup it made before it chose a
 * provider — the candidates, an agent's ERC-8004 reputation on Monad, the
 * provider's XorvLedger receipts, its Envio indexer stats, its payout
 * wallet's Nansen trust — in the broker's own words, with explorer links
 * where an agent, a receipt or a wallet is involved.
 *
 * Renders nothing for a record without steps (the router didn't run, or an
 * older broker), so it can sit under any routing line.
 */
export function RoutingTrace({
  routing,
  open = true,
  className,
}: {
  routing: unknown;
  open?: boolean;
  className?: string;
}) {
  const trace = routingTrace(routing);
  if (!trace) return null;
  const who = roleLabel(routing as { by?: unknown; label?: unknown }) ?? "The router";
  return (
    <details open={open} className={cn("group", className)}>
      <summary className="cursor-pointer list-none text-[11.5px] text-fg-3 transition-colors select-none hover:text-fg-2 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="mr-1 inline-block transition-transform group-open:rotate-90">
          ›
        </span>
        How {who} chose <span className="text-fg-4">· {describeTrace(trace)}</span>
      </summary>
      <ol className="mt-2 space-y-1.5 border-l border-[var(--line)] pl-3">
        {trace.steps.map((step, i) => (
          <li key={i} className="text-[11.5px] leading-relaxed">
            <span className={cn("mono mr-1.5", step.ok ? "text-fg-2" : "text-fail")}>{step.label}</span>
            <span className="text-fg-3">{step.summary}</span>
            {step.ms !== null && step.tool !== "select_provider" ? (
              <span className="mono ml-1.5 text-fg-4">{formatMs(step.ms)}</span>
            ) : null}
            {step.links.map((link) => (
              <a
                key={`${link.label}:${link.url}`}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-1.5 whitespace-nowrap text-fg-4 underline-offset-4 transition-colors hover:text-fg-2 hover:underline"
              >
                {link.label} ↗
              </a>
            ))}
          </li>
        ))}
      </ol>
      {trace.fallback ? (
        <p className="mt-1.5 pl-3 text-[11.5px] text-fg-4">
          The router&rsquo;s answer wasn&rsquo;t used ({trace.fallback}); the matcher chose on price, then reputation.
        </p>
      ) : null}
    </details>
  );
}
