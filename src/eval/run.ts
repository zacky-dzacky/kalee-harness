import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireResource } from "../core/roots.ts";
import type { ModelProvider } from "../model/provider.ts";
import { Session } from "../core/session.ts";
import { nullTrace, newId, Trace } from "../core/trace.ts";
import { readonlyPolicy } from "../core/policy.ts";
import type { BudgetLimits } from "../core/budget.ts";
import { review } from "../review/pipeline.ts";
import { resolveTarget } from "../review/target.ts";
import { aggregate, score, type Aggregate, type CaseScore, type Expected } from "./score.ts";

/**
 * Benchmark grounding (LAYERS.md: Verification).
 *
 * Fixtures are reviewed in `path` mode: each case is a small repo of seeded bugs plus traps a
 * naive reviewer tends to flag. Without this, every prompt edit is unfalsifiable.
 */
export function fixturesDir(): string {
  return requireResource("fixtures");
}

export async function listCases(dir = fixturesDir()): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "expected.json")))
    .map((e) => e.name)
    .sort();
}

export async function loadExpected(name: string, dir = fixturesDir()): Promise<Expected> {
  return JSON.parse(await readFile(join(dir, name, "expected.json"), "utf8")) as Expected;
}

export interface EvalOptions {
  scan: ModelProvider;
  verify: ModelProvider;
  cases?: string[];
  dir?: string;
  limits?: BudgetLimits;
  skipVerify?: boolean;
  /** Write per-run traces. Off by default so a sweep does not litter. */
  trace?: boolean;
  onProgress?(msg: string): void;
}

export interface EvalReport {
  scores: CaseScore[];
  total: Aggregate;
  models: { scan: string; verify: string };
}

export async function runEval(opts: EvalOptions): Promise<EvalReport> {
  const dir = opts.dir ?? fixturesDir();
  const names = opts.cases?.length ? opts.cases : await listCases(dir);
  if (names.length === 0) throw new Error(`no fixtures found in ${dir}`);

  // Session and trace files go to a scratch directory, not into the fixture repos: an eval
  // run must leave the fixtures exactly as it found them, or the next run reviews its own
  // leftovers.
  const scratch = await mkdtemp(join(tmpdir(), "kalee-eval-"));

  const scores: CaseScore[] = [];
  try {
    for (const name of names) {
      opts.onProgress?.(`${name}: reviewing`);
      const expected = await loadExpected(name, dir);
      const repo = join(dir, name, "repo");
      const started = Date.now();

      const id = newId();
      const trace = opts.trace ? new Trace(id, scratch) : nullTrace();
      const session = new Session(id, scratch);
      // Fixtures have no git history, so they are reviewed as paths, not diffs.
      const target = await resolveTarget({ kind: "path", path: "." }, repo);

      const result = await review({
        target,
        scan: opts.scan,
        verify: opts.verify,
        cwd: repo,
        trace,
        policy: readonlyPolicy(),
        session,
        effort: "high",
        limits: opts.limits,
        skipVerify: opts.skipVerify,
      });
      await session.flush();
      await trace.flush();

      const s = score(expected, result.findings, {
        costUsd: result.costUsd,
        durationMs: Date.now() - started,
      });
      scores.push(s);
      opts.onProgress?.(
        `${name}: recall ${pct(s.recall)} precision ${pct(s.precision)} (${s.matched.length}/${s.expected} found, ${s.falsePositives.length} extra)`,
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  return {
    scores,
    total: aggregate(scores),
    models: { scan: opts.scan.id, verify: opts.verify.id },
  };
}

export const pct = (n: number) => `${(n * 100).toFixed(0)}%`;
