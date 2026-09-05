import pc from "picocolors";
import type { Finding, Severity, Verdict } from "../finding.ts";
import type { ReviewResult } from "../pipeline.ts";
import type { Usage } from "../../model/ir.ts";
import { wrap } from "../../core/text.ts";

const SEVERITY_COLOR: Record<Severity, (s: string) => string> = {
  critical: (s) => pc.bgRed(pc.white(pc.bold(` ${s} `))),
  high: (s) => pc.red(pc.bold(s)),
  medium: (s) => pc.yellow(s),
  low: (s) => pc.dim(s),
};

const VERDICT_MARK: Record<Verdict, string> = {
  confirmed: pc.green("✓ confirmed"),
  plausible: pc.yellow("? plausible"),
  rejected: pc.dim("✗ rejected"),
};

export function renderTerminal(
  result: ReviewResult,
  meta: { label: string; usage: Usage; models: { scan: string; verify: string }; durationMs: number },
): string {
  const lines: string[] = [];
  const { findings } = result;

  lines.push("");
  if (findings.length === 0) {
    lines.push(pc.green("No findings.") + pc.dim(` (${meta.label})`));
  } else {
    const n = findings.length;
    lines.push(pc.bold(`${n} finding${n === 1 ? "" : "s"}`) + pc.dim(` — ${meta.label}`));
    lines.push("");
    for (const f of findings) lines.push(...renderOne(f));
  }

  lines.push(pc.dim("─".repeat(60)));
  lines.push(footer(result, meta));
  return lines.join("\n");
}

function renderOne(f: Finding): string[] {
  const out: string[] = [];
  // `file:line` on its own, unstyled, so terminals keep it clickable.
  out.push(
    `${SEVERITY_COLOR[f.severity](f.severity)} ${pc.dim(f.category)}  ${VERDICT_MARK[f.verdict]}`,
  );
  out.push(pc.cyan(`${f.file}:${f.line}`));
  out.push(`  ${f.summary}`);
  out.push(pc.dim(`  ${wrap(f.failureScenario, 76, "  ")}`));
  if (f.rationale && f.verdict !== "confirmed") {
    out.push(pc.dim(`  verifier: ${wrap(f.rationale, 76, "  ")}`));
  }
  out.push("");
  return out;
}

function footer(
  result: ReviewResult,
  meta: { usage: Usage; models: { scan: string; verify: string }; durationMs: number },
): string {
  const { usage } = meta;
  const tokens = `${fmt(usage.input)} in / ${fmt(usage.output)} out`;
  const cached = usage.cacheRead > 0 ? pc.green(` (${fmt(usage.cacheRead)} cached)`) : "";
  const dropped = result.rejected.length ? pc.dim(` · ${result.rejected.length} rejected`) : "";
  const models =
    meta.models.scan === meta.models.verify
      ? meta.models.scan
      : `${meta.models.scan} → ${meta.models.verify}`;
  return pc.dim(
    `${models} · ${tokens}${cached} · $${result.costUsd.toFixed(4)} · ${(meta.durationMs / 1000).toFixed(1)}s${dropped}`,
  );
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
