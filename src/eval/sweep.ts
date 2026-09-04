import { makeProvider } from "../providers/index.ts";
import { lookup, type Registry } from "../model/registry.ts";
import type { BudgetLimits } from "../core/budget.ts";
import { runEval, type EvalReport } from "./run.ts";

/**
 * The same fixtures across backends, reporting **quality per dollar**.
 *
 * This falls out of the model layer being abstract, and it is the honest way to decide which
 * model each role deserves — including whether the expensive one is actually earning its cost.
 */
export interface SweepRow {
  model: string;
  recall: number;
  precision: number;
  f1: number;
  costUsd: number;
  durationMs: number;
  trapsHit: number;
  /** F1 per dollar. Infinite for a free local model that found anything. */
  valuePerDollar: number;
  error?: string;
}

export async function sweep(
  reg: Registry,
  modelIds: string[],
  opts: { cases?: string[]; limits?: BudgetLimits; skipVerify?: boolean; onProgress?(m: string): void },
): Promise<SweepRow[]> {
  const rows: SweepRow[] = [];

  for (const id of modelIds) {
    opts.onProgress?.(`── ${id}`);
    try {
      // Both roles get the same model: the sweep asks how this model does end to end.
      const provider = makeProvider(lookup(reg, id));
      const report: EvalReport = await runEval({
        scan: provider,
        verify: provider,
        cases: opts.cases,
        limits: opts.limits,
        skipVerify: opts.skipVerify,
        onProgress: (m) => opts.onProgress?.(`   ${m}`),
      });
      const t = report.total;
      rows.push({
        model: id,
        recall: t.recall,
        precision: t.precision,
        f1: t.f1,
        costUsd: t.costUsd,
        durationMs: t.durationMs,
        trapsHit: t.trapsHit,
        valuePerDollar: t.costUsd > 0 ? t.f1 / t.costUsd : Infinity,
      });
    } catch (e) {
      // One unreachable backend must not abandon the sweep.
      rows.push({
        model: id,
        recall: 0, precision: 0, f1: 0, costUsd: 0, durationMs: 0, trapsHit: 0,
        valuePerDollar: 0,
        error: (e as Error).message,
      });
    }
  }

  return rows;
}
