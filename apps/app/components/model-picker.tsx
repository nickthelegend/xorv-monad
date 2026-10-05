"use client";

import { Claude, Codex, Grok, OpenAI, OpenCode } from "@lobehub/icons";
import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Choosing which agent runs the job.
 *
 * A native `<select>` cannot draw anything but text, and the thing a buyer is
 * actually choosing between here is *Claude Code* and *Codex* — brands they
 * recognise on sight and read far faster than the words. So this is a listbox,
 * with the real marks.
 *
 * It is a menu of six items, opened by choice and closed immediately after, so
 * it animates: 140ms, scaled from the trigger's own corner so the panel reads
 * as coming *from* the button rather than appearing over it. Fast enough not to
 * be in the way of someone who opens it twenty times a day.
 *
 * Keyboard and click-away behaviour are hand-rolled rather than pulled in as a
 * dependency, because the surface is small and the alternative is 40kb to
 * render six rows.
 */

export interface ModelOption {
  id: string;
  label: string;
  /** What the buyer is actually getting, when the name doesn't say it. */
  hint?: string;
}

/**
 * Brand marks, monochrome.
 *
 * `.Color` variants exist and are deliberately unused: six logos at full
 * saturation in a black interface reads as a sponsor wall. These inherit
 * `currentColor`, so the selected row brightens with its text.
 */
function mark(id: string): ReactNode {
  const size = 15;
  switch (id) {
    case "claude-code":
      return <Claude size={size} />;
    case "codex":
      return <Codex size={size} />;
    case "grok":
      return <Grok size={size} />;
    case "opencode":
      return <OpenCode size={size} />;
    case "openai-compatible":
      return <OpenAI size={size} />;
    case "echo":
      return <EchoMark size={size} />;
    default:
      return <AnyMark size={size} />;
  }
}

/** "Any model" — a stack, because the network picks among several. */
function AnyMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M8 1.5 14.5 5 8 8.5 1.5 5 8 1.5Z M2.5 8 8 11 13.5 8 M2.5 11 8 14 13.5 11"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** Echo is a test harness, not a vendor — it gets a glyph, not a logo. */
function EchoMark({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
      <path
        d="M2 8h2.5l1.5-4 2 8 2-6 1.5 2H14"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function ModelPicker({
  value,
  options,
  onChange,
}: {
  value: string;
  options: ModelOption[];
  onChange: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.id === value) ?? options[0];

  // Close on an outside click or Escape. Both are the same intent — "not this"
  // — so they share a path and a focus return.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        root.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (open) setActive(Math.max(0, options.findIndex((o) => o.id === value)));
  }, [open, options, value]);

  function choose(id: string): void {
    onChange(id);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent): void {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => (i + 1) % options.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i - 1 + options.length) % options.length);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const option = options[active];
      if (option) choose(option.id);
    }
  }

  return (
    <div ref={root} className="relative" onKeyDown={onKeyDown}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${selected?.label ?? "any"}`}
        className="flex items-center gap-1.5 rounded-lg border border-[var(--line)] bg-black px-2.5 py-1.5 text-[12px] text-fg-2 outline-none transition-colors hover:border-[var(--line-2)] focus-visible:border-[var(--line-3)]"
      >
        <span aria-hidden className="flex h-[15px] w-[15px] items-center justify-center text-fg-2">
          {mark(selected?.id ?? "")}
        </span>
        <span>{selected?.label}</span>
        <svg
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden
          className={`text-fg-4 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        >
          <path d="M2 4l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open ? (
        <div
          role="listbox"
          aria-label="Model"
          // Grows from the trigger's top-left, so the panel is visibly the
          // button's own surface rather than a layer that arrived over it.
          className="absolute bottom-full left-0 z-50 mb-1.5 min-w-[190px] origin-bottom-left animate-[picker_140ms_cubic-bezier(0.23,1,0.32,1)] overflow-hidden rounded-xl border border-[var(--line-2)] bg-black p-1 shadow-[0_16px_40px_rgba(0,0,0,0.9)]"
        >
          {options.map((option, i) => {
            const isSelected = option.id === value;
            return (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-label={option.hint ? `${option.label} — ${option.hint}` : option.label}
                onClick={() => choose(option.id)}
                onMouseEnter={() => setActive(i)}
                className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12.5px] transition-colors ${
                  i === active ? "bg-white/[0.06] text-fg" : "text-fg-2"
                }`}
              >
                <span aria-hidden className="flex h-[15px] w-[15px] shrink-0 items-center justify-center">
                  {mark(option.id)}
                </span>
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {option.hint ? (
                  <span className="shrink-0 text-[11px] text-fg-4">{option.hint}</span>
                ) : null}
                {isSelected ? (
                  <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
                    <path d="M2.5 6.2l2.3 2.3 4.7-5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}

      <style jsx>{`
        @keyframes picker {
          from {
            opacity: 0;
            transform: scale(0.96) translateY(4px);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          [role="listbox"] {
            animation-duration: 1ms;
          }
        }
      `}</style>
    </div>
  );
}
