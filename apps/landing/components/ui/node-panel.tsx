"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * A provider node, mid-session.
 *
 * This is a transcript of a real `xorv start` run, replayed line by line the
 * first time it scrolls into view. Static markup would be honest but inert; a
 * looping animation would be a screensaver. Playing once, on arrival, is the
 * closest a page gets to showing you the thing working — and then it stops and
 * lets you read it.
 *
 * Marked `aria-hidden`: it is a picture of software, and a screen reader
 * walking a fake terminal line by line gains nothing. The facts it shows are
 * stated in prose elsewhere on the page.
 */

interface Line {
  /** Rendered content. */
  render: () => React.ReactNode;
  /** Pause after this line, in ms. */
  after?: number;
}

const LINES: Line[] = [
  {
    render: () => (
      <>
        <span className="text-fg-4">$</span> <span className="text-fg">xorv start</span>
      </>
    ),
    after: 420,
  },
  {
    render: () => (
      <>
        <Ok /> <span className="text-fg-2">2/2 capabilities ready</span>{" "}
        <span className="text-fg-4">— Claude Code, Codex</span>
      </>
    ),
    after: 160,
  },
  {
    render: () => (
      <>
        <Ok /> <span className="text-fg-2">registered as</span>{" "}
        <span className="text-fg">prv_1LanKLZA8vhK</span>
      </>
    ),
    after: 160,
  },
  {
    render: () => (
      <>
        <Ok /> <span className="text-fg-2">registration on HCS</span>{" "}
        <span className="text-fg-4">0.0.9848245</span>
      </>
    ),
    after: 380,
  },
  { render: () => <Rule />, after: 120 },
  {
    render: () => (
      <>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-live align-middle" />{" "}
        <span className="font-medium text-fg">LIVE</span>
        <Sep />
        <span className="text-fg-2">nivesh-macbook</span>
        <Sep />
        <span className="text-fg-3">beat 3s ago</span>
      </>
    ),
    after: 140,
  },
  {
    render: () => (
      <>
        <span className="tnum text-fg-2">earned</span>{" "}
        <span className="tnum font-medium text-fg">$1.4200</span>
        <Sep />
        <span className="tnum text-fg-2">7 done</span>
        <Sep />
        <span className="tnum text-fg-3">1 running</span>
      </>
    ),
    after: 460,
  },
  {
    render: () => (
      <>
        <span className="text-fg-4">▸</span>{" "}
        <span className="text-fg">job_gBc-RIOAyqW5</span>{" "}
        <span className="text-fg-3">claude-code</span>{" "}
        <span className="tnum text-fg-2">$0.2500</span>
      </>
    ),
    after: 300,
  },
  {
    render: () => <span className="pl-4 text-fg-4">Write: src/parser.ts</span>,
    after: 420,
  },
  {
    render: () => (
      <>
        <Ok /> <span className="text-fg-2">done in 8.4s — earned</span>{" "}
        <span className="tnum font-medium text-fg">$0.2500</span>
      </>
    ),
    after: 240,
  },
  {
    render: () => (
      <>
        <Ok /> <span className="text-fg-2">settled</span>{" "}
        <span className="text-fg-4">0.0.9842030@1785477682.129117457</span>
      </>
    ),
  },
];

export function NodePanel({ animate = true }: { animate?: boolean }) {
  const [shown, setShown] = useState(animate ? 0 : LINES.length);

  useEffect(() => {
    if (!animate) {
      setShown(LINES.length);
      return;
    }
    setShown(0);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;

    const step = (i: number): void => {
      if (cancelled || i >= LINES.length) return;
      setShown(i + 1);
      timer = setTimeout(() => step(i + 1), LINES[i]?.after ?? 200);
    };
    timer = setTimeout(() => step(0), 260);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [animate]);

  const done = shown >= LINES.length;

  return (
    <div
      aria-hidden
      className="overflow-hidden rounded-t-[20px] border border-b-0 border-[var(--line)] bg-black md:rounded-t-[26px]"
    >
      {/* Window chrome. Monochrome dots — three coloured circles would be the
          only decorative colour on the page, and they mean nothing here. */}
      <div className="flex items-center gap-2 border-b border-[var(--line)] px-4 py-3">
        <span className="flex gap-1.5">
          <Dot />
          <Dot />
          <Dot />
        </span>
        <span className="mono ml-2 text-[11px] text-fg-4">xorv — provider node</span>
        <span className="ml-auto rounded-full border border-[var(--line)] px-2 py-0.5 text-[10px] text-fg-4">
          example session
        </span>
      </div>

      <div className="mono min-h-[300px] space-y-[7px] p-5 text-[12.5px] leading-relaxed sm:min-h-[330px] sm:p-6 sm:text-[13px]">
        {LINES.slice(0, shown).map((line, i) => (
          <div key={i}>{line.render()}</div>
        ))}
        {done ? (
          <div className="pt-1">
            <span className="text-fg-4">$</span>{" "}
            <span className="cursor inline-block h-[13px] w-[7px] translate-y-[2px] bg-fg-3" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Ok() {
  return <span className="text-fg-3">✓</span>;
}

function Dot() {
  return <span className="h-2.5 w-2.5 rounded-full border border-[var(--line-2)]" />;
}

function Sep() {
  return <span className="px-2 text-fg-4">│</span>;
}

function Rule() {
  return <span className={cn("block text-fg-4")}>{"─".repeat(38)}</span>;
}
