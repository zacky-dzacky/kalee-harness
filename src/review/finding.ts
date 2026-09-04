import { z } from "zod";

export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "correctness",
  "security",
  "concurrency",
  "resource-leak",
  "error-handling",
  "api-misuse",
  "performance",
  "test-coverage",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type Verdict = "confirmed" | "plausible" | "rejected";

/**
 * The schema every finding must satisfy. `failureScenario` is deliberately required: a claim
 * that cannot name concrete inputs leading to a concrete wrong output is a code-style opinion,
 * and forcing the field is the cheapest precision filter in the pipeline.
 */
export const findingSchema = z.object({
  file: z.string().describe("Repository-relative path."),
  line: z.number().int().min(1).describe("1-based line the finding anchors to."),
  severity: z.enum(SEVERITIES),
  category: z.enum(CATEGORIES),
  summary: z.string().min(10).describe("One sentence stating the defect."),
  failureScenario: z
    .string()
    .min(20)
    .describe("Concrete inputs or state leading to a concrete wrong output or crash."),
});

export type FindingInput = z.infer<typeof findingSchema>;

export interface Finding extends FindingInput {
  id: string;
  verdict: Verdict;
  /** Why the verify pass reached its verdict. */
  rationale?: string;
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const VERDICT_RANK: Record<Verdict, number> = { confirmed: 0, plausible: 1, rejected: 2 };

/** Confirmed before plausible, then by severity, then by location for a stable order. */
export function rank(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      a.file.localeCompare(b.file) ||
      a.line - b.line,
  );
}

/** Two findings on the same line in the same category are the same finding. */
export function dedupe(findings: Finding[]): Finding[] {
  const seen = new Map<string, Finding>();
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.category}`;
    const prior = seen.get(key);
    if (!prior || SEVERITY_RANK[f.severity] < SEVERITY_RANK[prior.severity]) seen.set(key, f);
  }
  return [...seen.values()];
}
