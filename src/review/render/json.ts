import type { Usage } from "../../model/ir.ts";
import type { ReviewResult } from "../pipeline.ts";

export interface JsonReport {
  target: string;
  models: { scan: string; verify: string };
  findings: ReviewResult["findings"];
  rejected: ReviewResult["rejected"];
  usage: Usage;
  costUsd: number;
  durationMs: number;
  traceId: string;
}

export function renderJson(
  result: ReviewResult,
  meta: {
    label: string;
    usage: Usage;
    models: { scan: string; verify: string };
    durationMs: number;
    traceId: string;
  },
): string {
  const report: JsonReport = {
    target: meta.label,
    models: meta.models,
    findings: result.findings,
    rejected: result.rejected,
    usage: meta.usage,
    costUsd: Number(result.costUsd.toFixed(6)),
    durationMs: meta.durationMs,
    traceId: meta.traceId,
  };
  return JSON.stringify(report, null, 2);
}
