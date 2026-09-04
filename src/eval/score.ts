import type { Finding } from "../review/finding.ts";

/**
 * Ground truth for one fixture: the bugs that must be found, and the traps that must not be
 * reported. The traps matter as much as the bugs — a scorer that only measures recall rewards
 * a reviewer that flags everything.
 */
export interface Expected {
  case: string;
  description: string;
  bugs: ExpectedBug[];
  /** Places a naive reviewer tends to flag that are actually correct. */
  traps?: { file: string; line?: number; why: string }[];
}

export interface ExpectedBug {
  file: string;
  line: number;
  /** Lines either side of `line` that still count as finding this bug. */
  tolerance?: number;
  category?: string;
  hint: string;
}

export interface CaseScore {
  case: string;
  expected: number;
  found: number;
  matched: { bug: ExpectedBug; finding: Finding }[];
  missed: ExpectedBug[];
  falsePositives: Finding[];
  trapsHit: Finding[];
  recall: number;
  precision: number;
  f1: number;
  costUsd: number;
  durationMs: number;
}

const DEFAULT_TOLERANCE = 3;

export function score(
  expected: Expected,
  findings: Finding[],
  meta: { costUsd: number; durationMs: number },
): CaseScore {
  const matched: CaseScore["matched"] = [];
  const missed: ExpectedBug[] = [];
  const claimed = new Set<Finding>();

  for (const bug of expected.bugs) {
    const tol = bug.tolerance ?? DEFAULT_TOLERANCE;
    const hit = findings.find(
      (f) => !claimed.has(f) && sameFile(f.file, bug.file) && Math.abs(f.line - bug.line) <= tol,
    );
    if (hit) {
      claimed.add(hit);
      matched.push({ bug, finding: hit });
    } else {
      missed.push(bug);
    }
  }

  const falsePositives = findings.filter((f) => !claimed.has(f));
  const trapsHit = falsePositives.filter((f) =>
    (expected.traps ?? []).some(
      (t) => sameFile(f.file, t.file) && (t.line === undefined || Math.abs(f.line - t.line) <= DEFAULT_TOLERANCE),
    ),
  );

  const recall = expected.bugs.length === 0 ? 1 : matched.length / expected.bugs.length;
  // A clean fixture that produced no findings is perfect precision, not 0/0.
  const precision = findings.length === 0 ? 1 : matched.length / findings.length;
  const f1 = recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision);

  return {
    case: expected.case,
    expected: expected.bugs.length,
    found: findings.length,
    matched,
    missed,
    falsePositives,
    trapsHit,
    recall,
    precision,
    f1,
    costUsd: meta.costUsd,
    durationMs: meta.durationMs,
  };
}

/** Fixture paths and reported paths can differ by a leading `./` or a fixture-root prefix. */
function sameFile(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/^\.\//, "").replace(/^\/+/, "");
  const x = norm(a);
  const y = norm(b);
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

export interface Aggregate {
  cases: number;
  recall: number;
  precision: number;
  f1: number;
  costUsd: number;
  durationMs: number;
  trapsHit: number;
}

export function aggregate(scores: CaseScore[]): Aggregate {
  const n = scores.length || 1;
  const totalBugs = scores.reduce((a, s) => a + s.expected, 0);
  const totalMatched = scores.reduce((a, s) => a + s.matched.length, 0);
  const totalFound = scores.reduce((a, s) => a + s.found, 0);
  // Micro-averaged: one case with ten bugs should weigh more than one with a single bug.
  const recall = totalBugs === 0 ? 1 : totalMatched / totalBugs;
  const precision = totalFound === 0 ? 1 : totalMatched / totalFound;
  return {
    cases: scores.length,
    recall,
    precision,
    f1: recall + precision === 0 ? 0 : (2 * recall * precision) / (recall + precision),
    costUsd: scores.reduce((a, s) => a + s.costUsd, 0),
    durationMs: scores.reduce((a, s) => a + s.durationMs, 0),
    trapsHit: scores.reduce((a, s) => a + s.trapsHit.length, 0),
  };
}
