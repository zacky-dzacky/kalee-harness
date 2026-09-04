import { z } from "zod";
import type { Effort } from "../model/ir.ts";
import type { ModelProvider } from "../model/provider.ts";
import { ContextBuilder, repoMap } from "../core/context.ts";
import { loadOverlay, loadPrompt } from "../core/identity.ts";
import { runLoop } from "../core/loop.ts";
import { planBatches } from "../core/compact.ts";
import type { Policy } from "../core/policy.ts";
import { Session } from "../core/session.ts";
import { requireSkill } from "../core/skills.ts";
import type { Trace } from "../core/trace.ts";
import type { BudgetLimits } from "../core/budget.ts";
import { ToolRegistry, reviewRegistry, type Tool } from "../tools/index.ts";
import { ok } from "../tools/types.ts";
import { dedupe, findingSchema, rank, type Finding, type FindingInput, type Verdict } from "./finding.ts";
import { renderTarget, type FileChange, type ReviewTarget } from "./target.ts";

export interface PipelineOptions {
  target: ReviewTarget;
  scan: ModelProvider;
  verify: ModelProvider;
  cwd: string;
  trace: Trace;
  policy: Policy;
  session: Session;
  effort?: Effort;
  limits?: BudgetLimits;
  signal?: AbortSignal;
  /** Skip the verify pass — faster, noisier. */
  skipVerify?: boolean;
  onProgress?(phase: string, detail: string): void;
  onText?(text: string): void;
}

export interface ReviewResult {
  findings: Finding[];
  /** Candidates the verify pass rejected. Kept for the trace, dropped from output. */
  rejected: Finding[];
  costUsd: number;
  batches: number;
}

export async function review(opts: PipelineOptions): Promise<ReviewResult> {
  const candidates = await scanPass(opts);
  if (opts.skipVerify) {
    return {
      findings: rank(candidates.map((c) => ({ ...c, verdict: "plausible" as Verdict }))),
      rejected: [],
      costUsd: opts.trace.costUsd(),
      batches: candidates.length ? 1 : 0,
    };
  }
  const verified = await verifyPass(candidates, opts);
  return {
    findings: rank(verified.filter((f) => f.verdict !== "rejected")),
    rejected: verified.filter((f) => f.verdict === "rejected"),
    costUsd: opts.trace.costUsd(),
    batches: candidates.length ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Pass 1 — scan. Agent loop over the target with read-only tools.
// ---------------------------------------------------------------------------

async function scanPass(opts: PipelineOptions): Promise<Finding[]> {
  const { target, scan, cwd, trace } = opts;
  const skill = await requireSkill(cwd, "code-review");
  const identity = await loadPrompt("identity");
  const overlay = await loadOverlay(cwd);

  const builder = new ContextBuilder()
    .identity(identity)
    .skill(skill)
    .overlay(overlay)
    .addStable(await repoMap(cwd));
  const system = builder.build();

  const tools = skill.tools ? reviewRegistry().select(skill.tools) : reviewRegistry();

  // Degrade to per-file map-reduce rather than failing when the diff cannot fit.
  const plan = await planBatches(
    scan,
    system,
    target.files,
    (files) => renderTarget(target, files),
    8192,
  );
  trace.note("scan", plan.reason, { batches: plan.batches.length });
  if (plan.batches.length > 1) {
    opts.onProgress?.("scan", `context too small for one pass — splitting into ${plan.batches.length}`);
  }

  const found: FindingInput[] = [];
  let batchNo = 0;

  for (const batch of plan.batches) {
    batchNo++;
    const pass = plan.batches.length > 1 ? `scan[${batchNo}/${plan.batches.length}]` : "scan";
    opts.onProgress?.(pass, `${batch.length} file(s)`);

    // Each batch is its own context. Sharing one would defeat the point of splitting.
    const session = plan.batches.length > 1 ? opts.session.fork(`scan${batchNo}`) : opts.session;
    session.user([{ type: "text", text: scanInstruction(target, batch) }], pass);

    await runLoop({
      provider: scan,
      tools,
      system,
      session,
      trace,
      policy: opts.policy,
      cwd,
      pass,
      effort: opts.effort ?? "high",
      limits: opts.limits,
      signal: opts.signal,
      onText: opts.onText,
      onEmit: (kind, value) => {
        if (kind !== "finding") return;
        const f = value as FindingInput;
        found.push(f);
        trace.write({ t: "finding", at: new Date().toISOString(), pass, finding: f });
        opts.onProgress?.(pass, `found ${f.file}:${f.line} — ${f.summary}`);
      },
    });
    await session.flush();
  }

  const withIds = found.map((f, i) => ({ ...f, id: `f${i + 1}`, verdict: "plausible" as Verdict }));
  return dedupe(withIds);
}

function scanInstruction(target: ReviewTarget, files: FileChange[]): string {
  const payload = renderTarget(target, files);
  const task = target.wholeFile
    ? "Review these files for correctness defects. There is no diff, so judge the code as it stands."
    : "Review this change for correctness defects introduced or exposed by it.";
  return `${payload}

---

${task}

Read whatever surrounding code you need before making a claim. Report each defect with
\`report_finding\`. If the change is correct, report nothing and say so.`;
}

// ---------------------------------------------------------------------------
// Pass 2 — verify. The single biggest precision lever.
// ---------------------------------------------------------------------------

const verdictSchema = z.object({
  verdict: z.enum(["confirmed", "plausible", "rejected"]),
  rationale: z
    .string()
    .min(10)
    .describe("Why, citing what you read. For `rejected`, name the assumption that turned out false."),
});

async function verifyPass(candidates: Finding[], opts: PipelineOptions): Promise<Finding[]> {
  if (candidates.length === 0) return [];
  const identity = await loadPrompt("verify");
  const out: Finding[] = [];

  for (const [i, candidate] of candidates.entries()) {
    const pass = `verify[${i + 1}/${candidates.length}]`;
    opts.onProgress?.(pass, `${candidate.file}:${candidate.line}`);

    let verdict: Verdict = "plausible";
    let rationale = "the verifier returned no verdict";
    let decided = false;

    const verdictTool: Tool = {
      name: "verdict",
      description: "Return your verdict on the claim. Call this exactly once, then stop.",
      schema: verdictSchema,
      effect: "read-only",
      parallelSafe: false,
      async call(input) {
        const parsed = verdictSchema.parse(input);
        verdict = parsed.verdict;
        rationale = parsed.rationale;
        decided = true;
        return ok(`recorded verdict: ${parsed.verdict}`);
      },
    };

    // A *fresh, isolated* context. Handing the verifier the scan's transcript would just make
    // it agree with itself, which is the whole failure mode this pass exists to catch.
    const session = opts.session.fork(`verify${i + 1}`);
    const system = new ContextBuilder().identity(identity).build();
    const tools = new ToolRegistry([
      ...reviewRegistry()
        .list()
        .filter((t) => t.name !== "report_finding"),
      verdictTool,
    ]);

    session.user([{ type: "text", text: claimText(candidate) }], pass);

    try {
      await runLoop({
        provider: opts.verify,
        tools,
        system,
        session,
        trace: opts.trace,
        policy: opts.policy,
        cwd: opts.cwd,
        pass,
        effort: opts.effort === "max" ? "high" : (opts.effort ?? "medium"),
        limits: opts.limits,
        signal: opts.signal,
        // One verdict is the whole task; there is nothing to do after it.
        stopWhen: () => decided,
      });
    } catch (e) {
      // A verifier failure must not delete the candidate — degrade to unverified instead.
      opts.trace.error(pass, "verify_failed", (e as Error).message);
      verdict = "plausible";
      rationale = `verification did not complete: ${(e as Error).message}`;
    }
    await session.flush();

    opts.onProgress?.(pass, `${verdict}: ${candidate.file}:${candidate.line}`);
    out.push({ ...candidate, verdict, rationale });
  }

  return out;
}

function claimText(f: Finding): string {
  return `Verify this claim.

- **File:** ${f.file}
- **Line:** ${f.line}
- **Category:** ${f.category}
- **Severity claimed:** ${f.severity}

**Summary:** ${f.summary}

**Failure scenario claimed:** ${f.failureScenario}

Read the actual code at that location and whatever it depends on. Then call \`verdict\` once.`;
}

export { findingSchema };
