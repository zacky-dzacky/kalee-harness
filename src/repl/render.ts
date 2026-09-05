import pc from "picocolors";
import { terminalWidth, truncate, tildify } from "../core/text.ts";
import type { ToolEvent } from "../core/loop.ts";
import type { Usage } from "../model/ir.ts";

/**
 * Terminal presentation for the interactive session.
 *
 * The markup pass is deliberately small — bold, inline code, headings, fenced blocks — because
 * a full markdown renderer in a streaming terminal is mostly a way to mangle code. Wrapping
 * happens over *runs* rather than the finished string: applying colour first and wrapping after
 * measures escape sequences as if they were characters, and the line lengths come out wrong.
 */
export type Style = "plain" | "bold" | "code" | "dim";

export interface Run {
  text: string;
  style: Style;
}

const STYLES: Record<Style, (s: string) => string> = {
  plain: (s) => s,
  bold: (s) => pc.bold(s),
  code: (s) => pc.cyan(s),
  dim: (s) => pc.dim(s),
};

/** Split one line into styled runs. `**bold**` and `` `code` `` only. */
export function tokenize(line: string): Run[] {
  const runs: Run[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m.index > last) runs.push({ text: line.slice(last, m.index), style: "plain" });
    if (m[1] !== undefined) runs.push({ text: m[1], style: "bold" });
    else if (m[2] !== undefined) runs.push({ text: m[2], style: "code" });
    last = m.index + m[0].length;
  }
  if (last < line.length) runs.push({ text: line.slice(last), style: "plain" });
  return runs;
}

/** Pack runs into wrapped, coloured lines. Styling is applied per fragment, after measuring. */
export function wrapRuns(runs: Run[], width: number, indent = ""): string {
  const out: string[] = [];
  let line = "";
  let plain = 0;

  const flush = () => {
    if (line) out.push(line);
    line = "";
    plain = 0;
  };

  for (const run of runs) {
    // Keep the separators so a run's internal spacing survives the split.
    for (const word of run.text.split(/(\s+)/)) {
      if (!word) continue;
      if (/^\s+$/.test(word)) {
        if (plain > 0) {
          line += STYLES[run.style](word);
          plain += word.length;
        }
        continue;
      }
      if (plain > 0 && plain + word.length > width) flush();
      line += STYLES[run.style](word);
      plain += word.length;
    }
  }
  flush();
  return out.map((l, i) => (i === 0 ? l : indent + l)).join("\n");
}

/**
 * Line-buffered streaming renderer.
 *
 * Buffering to a newline is what makes markup split across two deltas safe: `**bo` in one chunk
 * and `ld**` in the next must not reach the terminal as literal asterisks. It is the same
 * discipline `providers/shim.ts` applies to tool tags, for the same reason.
 */
export class StreamRenderer {
  private buf = "";
  private fenced = false;
  private wrote = false;

  constructor(
    private readonly write: (s: string) => void = (s) => process.stdout.write(s),
    private readonly width: number = terminalWidth() - 2,
  ) {}

  push(delta: string): void {
    this.buf += delta;
    let nl = this.buf.indexOf("\n");
    while (nl !== -1) {
      this.emit(this.buf.slice(0, nl));
      this.buf = this.buf.slice(nl + 1);
      nl = this.buf.indexOf("\n");
    }
  }

  /** Emit whatever is buffered. Safe to call repeatedly; the renderer stays usable after. */
  flush(): void {
    if (this.buf.length === 0) return;
    this.emit(this.buf);
    this.buf = "";
  }

  /** True once anything has been written — lets the caller decide about separating blank lines. */
  get dirty(): boolean {
    return this.wrote;
  }

  private emit(line: string): void {
    this.wrote = true;
    if (/^\s*```/.test(line)) {
      this.fenced = !this.fenced;
      const lang = line.replace(/^\s*```/, "").trim();
      this.write(pc.dim(this.fenced && lang ? `  ${lang}` : "  ─") + "\n");
      return;
    }
    if (this.fenced) {
      // Code is never wrapped: a folded line is worse than one that runs off the edge.
      this.write(`  ${line}\n`);
      return;
    }
    if (!line.trim()) {
      this.write("\n");
      return;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      this.write(`  ${pc.bold(heading[2] ?? "")}\n`);
      return;
    }
    this.write(`  ${wrapRuns(tokenize(line), this.width, "  ")}\n`);
  }
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/** The most identifying argument per tool, so a call reads like the thing it is doing. */
function toolArg(name: string, input: unknown): string {
  const o = (input ?? {}) as Record<string, unknown>;
  const pick = (...keys: string[]): string | undefined => {
    for (const k of keys) if (typeof o[k] === "string" && o[k]) return o[k] as string;
    return undefined;
  };
  switch (name) {
    case "read_file":
      return String(pick("path") ?? "");
    case "grep":
      return [pick("pattern"), pick("path")].filter(Boolean).join(" in ");
    case "glob":
      return String(pick("pattern") ?? "");
    case "bash":
      return String(pick("command") ?? "");
    case "report_finding":
      return `${pick("file") ?? "?"}:${o.line ?? "?"}`;
    default:
      return pick("path", "pattern", "command", "base", "ref", "file") ?? "";
  }
}

export function toolLine(e: ToolEvent, width = terminalWidth()): string {
  const arg = truncate(toolArg(e.name, e.input), Math.max(20, width - e.name.length - 12));
  if (e.phase === "start") {
    return `${pc.blue("⏺")} ${pc.bold(e.name)}${arg ? pc.dim(`(${arg})`) : ""}`;
  }
  const mark = e.isError ? pc.red("✗") : pc.dim("⎿");
  const body = truncate(e.preview ?? "", Math.max(20, width - 12));
  return `  ${mark} ${pc.dim(body)}`;
}

export function banner(model: string, cwd: string, branch: string | null, home: string): string {
  const where = tildify(cwd, home) + (branch ? pc.dim(` (${branch})`) : "");
  return `\n  ${pc.bold("Kalee")} ${pc.dim("·")} ${pc.cyan(model)} ${pc.dim("·")} ${where}\n`;
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** `ms` is omitted where nothing was timed — a running total is not a 0.0s operation. */
export function statusLine(model: string, usage: Usage, costUsd: number, ms?: number): string {
  const cached = usage.cacheRead > 0 ? pc.green(` (${fmtTokens(usage.cacheRead)} cached)`) : "";
  const took = ms === undefined ? "" : ` · ${(ms / 1000).toFixed(1)}s`;
  return pc.dim(
    `  ${model} · ${fmtTokens(usage.input)} in / ${fmtTokens(usage.output)} out`,
  ) + cached + pc.dim(` · $${costUsd.toFixed(4)}${took}`);
}
