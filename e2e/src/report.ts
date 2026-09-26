/**
 * What a run did and what it proved, for the terminal and for last-run.md.
 *
 * Three kinds of entry: *steps* (the sequence the run went through, timed),
 * *checks* (assertions — each one a fact read back from the chain or an API,
 * compared with what it should be), and *facts* (addresses, hashes and other
 * context a reader needs to follow the checks). A run passes when every step
 * finished and every check held.
 */

export interface Step {
  name: string;
  ms: number;
  ok: boolean;
  notes: string[];
}

export interface Check {
  section: string;
  name: string;
  ok: boolean;
  detail: string;
}

export interface Fact {
  section: string;
  label: string;
  value: string;
}

const useColor = Boolean(process.stderr.isTTY) && !process.env.NO_COLOR;
const paint = (code: number, text: string) => (useColor ? `\u001b[${code}m${text}\u001b[0m` : text);
export const green = (text: string) => paint(32, text);
export const red = (text: string) => paint(31, text);
export const dim = (text: string) => paint(2, text);
export const bold = (text: string) => paint(1, text);

export class Report {
  readonly startedAt = new Date();
  readonly steps: Step[] = [];
  readonly checks: Check[] = [];
  readonly facts: Fact[] = [];
  error: string | null = null;
  private section = "setup";

  /** Run one step, timing it and recording failure before rethrowing. */
  async step<T>(name: string, fn: (note: (line: string) => void) => Promise<T>): Promise<T> {
    const started = Date.now();
    const notes: string[] = [];
    this.section = name;
    process.stderr.write(`${bold("▸")} ${name}\n`);
    const note = (line: string) => {
      notes.push(line);
      process.stderr.write(`  ${dim(line)}\n`);
    };
    try {
      const value = await fn(note);
      const ms = Date.now() - started;
      this.steps.push({ name, ms, ok: true, notes });
      process.stderr.write(`  ${green("✓")} ${dim(`${(ms / 1000).toFixed(1)}s`)}\n`);
      return value;
    } catch (err) {
      const ms = Date.now() - started;
      this.steps.push({ name, ms, ok: false, notes: [...notes, err instanceof Error ? err.message : String(err)] });
      process.stderr.write(`  ${red("✗")} ${err instanceof Error ? err.message : String(err)}\n`);
      throw err;
    }
  }

  /** Record an assertion. Never throws: every check runs, and the run fails at the end if any did. */
  check(name: string, ok: boolean, detail = ""): boolean {
    this.checks.push({ section: this.section, name, ok, detail });
    process.stderr.write(`  ${ok ? green("✓") : red("✗")} ${name}${detail ? dim(` — ${detail}`) : ""}\n`);
    return ok;
  }

  /** Assert equality, rendering both sides on failure. */
  equal(name: string, actual: unknown, expected: unknown): boolean {
    const a = show(actual);
    const e = show(expected);
    const same = typeof actual === "string" && typeof expected === "string" && /^0x/i.test(actual) && /^0x/i.test(expected)
      ? actual.toLowerCase() === expected.toLowerCase()
      : a === e;
    return this.check(name, same, same ? a : `got ${a}, expected ${e}`);
  }

  fact(label: string, value: string | number | bigint | null | undefined, section = this.section): void {
    this.facts.push({ section, label, value: value === null || value === undefined ? "—" : String(value) });
  }

  get passed(): boolean {
    return this.error === null && this.steps.every((s) => s.ok) && this.checks.every((c) => c.ok);
  }

  summaryLine(): string {
    const total = Date.now() - this.startedAt.getTime();
    return this.passed
      ? green(`PASS — ${this.checks.length} checks, ${this.steps.length} steps, ${(total / 1000).toFixed(1)}s`)
      : red(`FAIL — ${this.verdict()}`);
  }

  /** Why a run failed, in one line: the failed checks, and where it stopped if it did. */
  private verdict(): string {
    const failed = this.checks.filter((c) => !c.ok).length;
    const parts = [`${failed} of ${this.checks.length} checks failed`];
    const stoppedAt = this.steps.find((s) => !s.ok)?.name;
    if (this.error) {
      const reason = this.error.split("\n")[0]!.slice(0, 200);
      parts.push(stoppedAt ? `stopped at "${stoppedAt}": ${reason}` : reason);
    }
    return parts.join("; ");
  }

  markdown(extra: { command: string; environment: Array<[string, string]> }): string {
    const total = Date.now() - this.startedAt.getTime();
    const lines: string[] = [];
    lines.push("# Xorv end-to-end run");
    lines.push("");
    lines.push(
      this.passed
        ? `**PASS** — ${this.checks.length}/${this.checks.length} checks, ${this.steps.length} steps, ` +
            `${(total / 1000).toFixed(1)} s. Started ${this.startedAt.toISOString()}.`
        : `**FAIL** — ${this.verdict()}. ${(total / 1000).toFixed(1)} s, started ${this.startedAt.toISOString()}.`,
    );
    lines.push("");
    lines.push(`Produced by \`${extra.command}\` (see [README.md](README.md)). Every value below was read back from the`);
    lines.push("forked chain or the running processes during the run; transaction hashes are local to that fork.");
    if (this.error) {
      lines.push("");
      lines.push("## Error");
      lines.push("");
      lines.push("```");
      lines.push(this.error);
      lines.push("```");
    }
    lines.push("");
    lines.push("## Environment");
    lines.push("");
    lines.push("| | |");
    lines.push("|---|---|");
    for (const [k, v] of extra.environment) lines.push(`| ${k} | ${cell(v)} |`);

    const sections = [...new Set(this.facts.map((f) => f.section))];
    for (const section of sections) {
      lines.push("");
      lines.push(`## ${capitalize(section)}`);
      lines.push("");
      lines.push("| | |");
      lines.push("|---|---|");
      for (const f of this.facts.filter((x) => x.section === section)) lines.push(`| ${f.label} | ${cell(f.value)} |`);
    }

    lines.push("");
    lines.push("## Steps");
    lines.push("");
    lines.push("| # | Step | Time | Result |");
    lines.push("|---|---|---:|---|");
    this.steps.forEach((s, i) => lines.push(`| ${i + 1} | ${s.name} | ${(s.ms / 1000).toFixed(1)} s | ${s.ok ? "ok" : "FAILED"} |`));

    lines.push("");
    lines.push("## Checks");
    const checkSections = [...new Set(this.checks.map((c) => c.section))];
    for (const section of checkSections) {
      lines.push("");
      lines.push(`### ${capitalize(section)}`);
      lines.push("");
      lines.push("| | Check | Detail |");
      lines.push("|---|---|---|");
      for (const c of this.checks.filter((x) => x.section === section)) {
        lines.push(`| ${c.ok ? "✅" : "❌"} | ${cell(c.name)} | ${cell(c.detail)} |`);
      }
    }

    const noted = this.steps.filter((s) => s.notes.length > 0);
    if (noted.length > 0) {
      lines.push("");
      lines.push("## Step log");
      for (const s of noted) {
        lines.push("");
        lines.push(`**${s.name}**`);
        lines.push("");
        for (const n of s.notes) lines.push(`- ${n.replace(/\n/g, " ")}`);
      }
    }
    lines.push("");
    return lines.join("\n");
  }
}

function show(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  return JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

function cell(text: string): string {
  const flat = text.replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  return /^0x[0-9a-fA-F]{40,}$/.test(flat) ? `\`${flat}\`` : flat;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
