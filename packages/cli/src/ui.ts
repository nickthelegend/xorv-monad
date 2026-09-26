/**
 * Xorv's terminal look.
 *
 * All of it is hand-rolled ANSI rather than a rendering library, for one
 * practical reason: this CLI is the thing a stranger installs to earn money on
 * their own machine, so its dependency list is part of its trust story. Every
 * dependency is one more thing they'd have to audit. Colour, gradients, boxes,
 * spinners and live tables are a few hundred lines — worth owning.
 *
 * Everything degrades: no truecolor → 256 colour; no colour → plain text; not a
 * TTY → no spinners, no cursor games, clean logs a pipe can read.
 */

import pc from "picocolors";

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

const isTTY = Boolean(process.stdout.isTTY);
const noColor = Boolean(process.env.NO_COLOR) || process.env.TERM === "dumb";
const truecolor =
  !noColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");

export const tty = { isTTY, color: !noColor, truecolor };

/** Terminal width, clamped to something a box can actually live in. */
export function width(): number {
  return Math.max(48, Math.min(process.stdout.columns || 80, 120));
}

// ---------------------------------------------------------------------------
// Palette — electric violet → cyan, the Xorv gradient
// ---------------------------------------------------------------------------

export const BRAND = {
  violet: [124, 92, 255] as RGB,
  indigo: [99, 108, 255] as RGB,
  azure: [61, 170, 255] as RGB,
  cyan: [61, 220, 255] as RGB,
  mint: [80, 240, 200] as RGB,
  amber: [255, 184, 76] as RGB,
  rose: [255, 90, 120] as RGB,
  slate: [130, 138, 160] as RGB,
  dim: [88, 94, 112] as RGB,
};

type RGB = [number, number, number];

/** Colour a string with a truecolor foreground, degrading when unsupported. */
export function rgb(text: string, color: RGB): string {
  if (noColor) return text;
  if (!truecolor) return pc.cyan(text);
  const [r, g, b] = color;
  return `[38;2;${r};${g};${b}m${text}[39m`;
}

function lerp(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Paint a string across a colour ramp, one step per visible character.
 *
 * Escape sequences already in the input would be counted as characters and
 * throw the ramp off, so this is only ever applied to raw text.
 */
export function gradient(text: string, stops: RGB[] = [BRAND.violet, BRAND.cyan]): string {
  if (noColor || !truecolor) return pc.cyan(text);
  const chars = [...text];
  const visible = chars.filter((c) => c !== " ").length || 1;
  let seen = 0;
  return chars
    .map((char) => {
      if (char === " ") return char;
      const t = visible === 1 ? 0 : seen++ / (visible - 1);
      const scaled = t * (stops.length - 1);
      const i = Math.min(stops.length - 2, Math.floor(scaled));
      const from = stops[i] ?? stops[0]!;
      const to = stops[i + 1] ?? stops[stops.length - 1]!;
      return rgb(char, lerp(from, to, scaled - i));
    })
    .join("");
}

// Semantic shorthands used across commands.
export const c = {
  brand: (s: string) => rgb(s, BRAND.violet),
  accent: (s: string) => rgb(s, BRAND.cyan),
  ok: (s: string) => rgb(s, BRAND.mint),
  warn: (s: string) => rgb(s, BRAND.amber),
  bad: (s: string) => rgb(s, BRAND.rose),
  muted: (s: string) => rgb(s, BRAND.dim),
  soft: (s: string) => rgb(s, BRAND.slate),
  bold: (s: string) => (noColor ? s : pc.bold(s)),
  money: (s: string) => rgb(s, BRAND.mint),
};

// ---------------------------------------------------------------------------
// The mark
// ---------------------------------------------------------------------------

const WORDMARK = [
  "██╗  ██╗ ██████╗ ██████╗ ██╗   ██╗",
  "╚██╗██╔╝██╔═══██╗██╔══██╗██║   ██║",
  " ╚███╔╝ ██║   ██║██████╔╝██║   ██║",
  " ██╔██╗ ██║   ██║██╔══██╗╚██╗ ██╔╝",
  "██╔╝ ██╗╚██████╔╝██║  ██║ ╚████╔╝ ",
  "╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═╝  ╚═══╝  ",
];

/**
 * The full banner, with the gradient running top-left to bottom-right.
 *
 * Each row starts a little further along the ramp than the one above, so the
 * colour sweeps diagonally across the block instead of repeating per line.
 */
export function banner(subtitle = "decentralized AI capacity network"): string {
  const rows = WORDMARK.map((row, i) => {
    const shift = i / (WORDMARK.length - 1);
    const from = lerp(BRAND.violet, BRAND.azure, shift * 0.6);
    const to = lerp(BRAND.cyan, BRAND.mint, shift * 0.5);
    return "  " + gradient(row, [from, to]);
  });
  return ["", ...rows, "", `  ${c.muted(subtitle)}`, ""].join("\n");
}

/** One-line mark for tight spots. */
export function markLine(): string {
  return `${gradient("▁▂▃")} ${c.bold(gradient("XORV"))}`;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Visible length, ignoring ANSI escapes — needed for any alignment. */
export function visibleLength(text: string): number {
  return stripAnsi(text).length;
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, "");
}

function pad(text: string, to: number): string {
  const len = visibleLength(text);
  return len >= to ? text : text + " ".repeat(to - len);
}

export interface BoxOptions {
  title?: string;
  color?: RGB;
  width?: number;
}

/** A rounded box. Lines may already contain colour; padding accounts for it. */
export function box(lines: string[], opts: BoxOptions = {}): string {
  const color = opts.color ?? BRAND.violet;
  const inner = (opts.width ?? width()) - 4;
  const edge = (s: string) => rgb(s, color);

  const top = opts.title
    ? edge("╭─ ") + c.bold(opts.title) + " " + edge("─".repeat(Math.max(0, inner - visibleLength(opts.title) - 1)) + "╮")
    : edge("╭" + "─".repeat(inner + 2) + "╮");

  // Split embedded newlines first: a caller passing one string containing a
  // whole multi-line result (a job answer, say) otherwise gets its newlines
  // measured as ordinary characters and the box's right edge comes apart.
  const body = lines
    .flatMap((line) => line.split("\n"))
    .flatMap((line) => wrap(line, inner))
    .map((piece) => `${edge("│")} ${pad(piece, inner)} ${edge("│")}`);

  return [top, ...body, edge("╰" + "─".repeat(inner + 2) + "╯")].join("\n");
}

/**
 * Wrap on word boundaries, hard-breaking anything that has none.
 *
 * The hard break is not a nicety. Boxes are drawn by padding each line to a
 * fixed width, so a single token wider than the box — a HashScan URL, a
 * transaction id, a sha-256 — pushes the right-hand border out and the frame
 * comes apart. Preferring word boundaries keeps prose readable; falling back to
 * a character break keeps the geometry true regardless of the content.
 */
export function wrap(text: string, max: number): string[] {
  if (max <= 0) return [text];
  if (visibleLength(text) <= max) return [text];

  const lines: string[] = [];
  let line = "";

  const flush = (): void => {
    if (line) lines.push(line);
    line = "";
  };

  for (const word of text.split(" ")) {
    // A token that can never fit gets split across as many rows as it needs.
    if (visibleLength(word) > max) {
      flush();
      for (const chunk of hardBreak(word, max)) lines.push(chunk);
      continue;
    }
    const candidate = line ? `${line} ${word}` : word;
    if (visibleLength(candidate) > max && line) {
      flush();
      line = word;
    } else {
      line = candidate;
    }
  }
  flush();
  return lines.length > 0 ? lines : [""];
}

/**
 * Split a token into `max`-wide pieces, counting only visible characters.
 *
 * Walks the string rather than slicing it, so an ANSI escape rides along with
 * the character it colours instead of being counted as width or cut in half.
 */
function hardBreak(token: string, max: number): string[] {
  const pieces: string[] = [];
  let piece = "";
  let visible = 0;
  let i = 0;

  while (i < token.length) {
    const escape = /^\[[0-9;]*m/.exec(token.slice(i));
    if (escape) {
      piece += escape[0];
      i += escape[0].length;
      continue;
    }
    piece += token[i];
    visible += 1;
    i += 1;
    if (visible === max) {
      pieces.push(piece);
      piece = "";
      visible = 0;
    }
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/** Aligned key/value block: `label   value`. */
export function kv(rows: Array<[string, string]>, gap = 2): string[] {
  const labelWidth = Math.max(...rows.map(([k]) => visibleLength(k)), 0);
  return rows.map(([k, v]) => `${c.muted(pad(k, labelWidth))}${" ".repeat(gap)}${v}`);
}

export interface Column {
  header: string;
  /** Fixed width; when omitted the column sizes to its widest cell. */
  width?: number;
  align?: "left" | "right";
}

/** A simple table with a dim rule under the header. */
export function table(columns: Column[], rows: string[][]): string {
  const widths = columns.map((col, i) => {
    if (col.width) return col.width;
    const cells = rows.map((r) => visibleLength(r[i] ?? ""));
    return Math.max(visibleLength(col.header), ...cells, 0);
  });

  const renderRow = (cells: string[], transform: (s: string) => string) =>
    columns
      .map((col, i) => {
        const cell = cells[i] ?? "";
        const w = widths[i] ?? 0;
        const padded =
          col.align === "right"
            ? " ".repeat(Math.max(0, w - visibleLength(cell))) + cell
            : pad(cell, w);
        return transform(padded);
      })
      .join("  ");

  const header = renderRow(
    columns.map((col) => col.header),
    (s) => c.muted(s),
  );
  const rule = c.muted(widths.map((w) => "─".repeat(w)).join("  "));
  return [header, rule, ...rows.map((row) => renderRow(row, (s) => s))].join("\n");
}

// ---------------------------------------------------------------------------
// Status glyphs and lines
// ---------------------------------------------------------------------------

export const glyph = {
  ok: () => c.ok("✔"),
  bad: () => c.bad("✖"),
  warn: () => c.warn("!"),
  info: () => c.accent("›"),
  dot: () => c.muted("·"),
  live: () => c.ok("●"),
  idle: () => c.warn("●"),
  off: () => c.muted("○"),
  money: () => rgb("◈", BRAND.mint),
  chain: () => rgb("⛓", BRAND.azure),
  bolt: () => rgb("⚡", BRAND.amber),
};

export function ok(message: string): void {
  console.log(`${glyph.ok()} ${message}`);
}
export function bad(message: string): void {
  console.log(`${glyph.bad()} ${message}`);
}
export function warn(message: string): void {
  console.log(`${glyph.warn()} ${message}`);
}
export function info(message: string): void {
  console.log(`${glyph.info()} ${message}`);
}
export function muted(message: string): void {
  console.log(c.muted(message));
}
export function blank(): void {
  console.log("");
}

/** A section heading with a rule out to the terminal edge. */
export function heading(title: string): void {
  const line = "─".repeat(Math.max(0, width() - visibleLength(title) - 3));
  console.log(`\n${c.bold(gradient(title))} ${c.muted(line)}`);
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  update(text: string): void;
  succeed(text?: string): void;
  fail(text?: string): void;
  stop(): void;
}

/**
 * A spinner that knows when it isn't wanted.
 *
 * Piped output gets one static line per state change instead of a stream of
 * cursor-control escapes, so `xorv start | tee node.log` stays readable.
 */
export function spinner(initial: string): Spinner {
  let text = initial;
  let frame = 0;
  let timer: NodeJS.Timeout | null = null;

  if (!isTTY) {
    console.log(`${glyph.info()} ${initial}`);
    return {
      update(next) {
        text = next;
        console.log(`${glyph.info()} ${next}`);
      },
      succeed(next) {
        console.log(`${glyph.ok()} ${next ?? text}`);
      },
      fail(next) {
        console.log(`${glyph.bad()} ${next ?? text}`);
      },
      stop() {},
    };
  }

  const render = (): void => {
    const f = FRAMES[frame % FRAMES.length] ?? "⠋";
    frame += 1;
    process.stdout.write(`\r[2K${rgb(f, BRAND.cyan)} ${text}`);
  };

  process.stdout.write("[?25l"); // hide cursor
  render();
  timer = setInterval(render, 80);
  timer.unref?.();

  const finish = (symbol: string, next?: string): void => {
    if (timer) clearInterval(timer);
    timer = null;
    process.stdout.write(`\r[2K${symbol} ${next ?? text}\n[?25h`);
  };

  return {
    update(next) {
      text = next;
    },
    succeed(next) {
      finish(glyph.ok(), next);
    },
    fail(next) {
      finish(glyph.bad(), next);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      process.stdout.write("\r[2K[?25h");
    },
  };
}

/** Make sure the cursor comes back even if we're killed mid-spin. */
export function installCursorGuard(): void {
  if (!isTTY) return;
  const restore = (): void => {
    process.stdout.write("[?25h");
  };
  process.on("exit", restore);
  process.on("SIGINT", () => {
    restore();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    restore();
    process.exit(143);
  });
}

// ---------------------------------------------------------------------------
// Prompts — small, dependency-free readline wrappers
// ---------------------------------------------------------------------------

import readline from "node:readline/promises";

export async function ask(question: string, fallback?: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = fallback ? c.muted(` (${fallback})`) : "";
    const answer = (await rl.question(`${c.accent("?")} ${question}${suffix} `)).trim();
    return answer || fallback || "";
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, fallback = true): Promise<boolean> {
  const hint = fallback ? "Y/n" : "y/N";
  const answer = (await ask(`${question} ${c.muted(`[${hint}]`)}`)).toLowerCase();
  if (!answer) return fallback;
  return answer.startsWith("y");
}

export async function select<T extends { label: string; hint?: string }>(
  question: string,
  options: T[],
): Promise<T> {
  console.log(`${c.accent("?")} ${question}`);
  options.forEach((opt, i) => {
    const num = c.bold(String(i + 1).padStart(2));
    const hint = opt.hint ? c.muted(` — ${opt.hint}`) : "";
    console.log(`  ${num}. ${opt.label}${hint}`);
  });
  while (true) {
    const answer = await ask(c.muted("choose"), "1");
    const index = Number(answer) - 1;
    const chosen = options[index];
    if (chosen) return chosen;
    bad(`pick a number between 1 and ${options.length}`);
  }
}

/** Multi-select: "1,3" or "all". Returns at least one option. */
export async function multiSelect<T extends { label: string; hint?: string }>(
  question: string,
  options: T[],
  defaults: number[] = [],
): Promise<T[]> {
  console.log(`${c.accent("?")} ${question} ${c.muted("(comma-separated, or 'all')")}`);
  options.forEach((opt, i) => {
    const marker = defaults.includes(i) ? c.ok("●") : c.muted("○");
    const hint = opt.hint ? c.muted(` — ${opt.hint}`) : "";
    console.log(`  ${marker} ${c.bold(String(i + 1).padStart(2))}. ${opt.label}${hint}`);
  });
  const fallback = defaults.length ? defaults.map((i) => i + 1).join(",") : "1";
  while (true) {
    const answer = (await ask(c.muted("choose"), fallback)).toLowerCase();
    if (answer === "all") return [...options];
    const picked = answer
      .split(",")
      .map((s) => Number(s.trim()) - 1)
      .filter((i) => Number.isInteger(i) && i >= 0 && i < options.length)
      .map((i) => options[i]!);
    if (picked.length) return picked;
    bad("pick at least one");
  }
}

// ---------------------------------------------------------------------------
// Live region — repaints a block in place without scrolling the terminal
// ---------------------------------------------------------------------------

export function liveRegion(): { render(lines: string[]): void; clear(): void; done(): void } {
  let painted = 0;
  const enabled = isTTY;

  return {
    render(lines: string[]) {
      if (!enabled) {
        // Non-TTY: print only the last line, so logs stay linear.
        const last = lines[lines.length - 1];
        if (last) console.log(stripAnsi(last));
        return;
      }
      if (painted > 0) process.stdout.write(`[${painted}A`);
      const out = lines.map((line) => `[2K${line}`).join("\n");
      process.stdout.write(out + "\n");
      painted = lines.length;
    },
    clear() {
      if (!enabled || painted === 0) return;
      process.stdout.write(`[${painted}A`);
      process.stdout.write("[0J");
      painted = 0;
    },
    done() {
      painted = 0;
    },
  };
}

/** A tiny sparkline from a series, for the earnings view. */
export function sparkline(values: number[], colorAt?: (v: number) => RGB): string {
  if (values.length === 0) return c.muted("—");
  const bars = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  const max = Math.max(...values, 1);
  return values
    .map((v) => {
      const idx = Math.min(bars.length - 1, Math.round((v / max) * (bars.length - 1)));
      const char = bars[idx] ?? "▁";
      return rgb(char, colorAt?.(v) ?? BRAND.cyan);
    })
    .join("");
}

/** A horizontal meter: `████████░░░░  62%`. */
export function meter(fraction: number, cells = 20): string {
  const clamped = Math.max(0, Math.min(1, fraction));
  const filled = Math.round(clamped * cells);
  const color: RGB = clamped > 0.85 ? BRAND.rose : clamped > 0.6 ? BRAND.amber : BRAND.mint;
  return rgb("█".repeat(filled), color) + c.muted("░".repeat(cells - filled));
}
