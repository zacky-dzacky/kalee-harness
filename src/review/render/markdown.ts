import type { Usage } from "../../model/ir.ts";
import type { Finding } from "../finding.ts";
import type { ReviewResult } from "../pipeline.ts";

export function renderMarkdown(
  result: ReviewResult,
  meta: { label: string; usage: Usage; models: { scan: string; verify: string }; durationMs: number },
): string {
  const out: string[] = [`## Code review — ${meta.label}`, ""];

  if (result.findings.length === 0) {
    out.push("No findings.", "");
  } else {
    for (const f of result.findings) out.push(...section(f));
  }

  out.push(
    "---",
    "",
    `<sub>${meta.models.scan} → ${meta.models.verify} · ${meta.usage.input} in / ${meta.usage.output} out · $${result.costUsd.toFixed(4)} · ${(meta.durationMs / 1000).toFixed(1)}s</sub>`,
  );
  return out.join("\n");
}

function section(f: Finding): string[] {
  const badge = f.verdict === "confirmed" ? "**confirmed**" : "_plausible_";
  return [
    `### \`${f.file}:${f.line}\` — ${f.severity} · ${f.category} · ${badge}`,
    "",
    f.summary,
    "",
    `**Failure scenario.** ${f.failureScenario}`,
    ...(f.rationale && f.verdict !== "confirmed" ? ["", `**Verifier.** ${f.rationale}`] : []),
    "",
  ];
}
