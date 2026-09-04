import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Block, Event, Request } from "../src/model/ir.ts";
import { DEFAULT_CAPS, type Capabilities, type ModelProvider, type Pricing } from "../src/model/provider.ts";
import { review } from "../src/review/pipeline.ts";
import { resolveTarget } from "../src/review/target.ts";
import { Session } from "../src/core/session.ts";
import { nullTrace } from "../src/core/trace.ts";
import { readonlyPolicy } from "../src/core/policy.ts";

/**
 * The two-pass pipeline end to end, with scripted models. This is what makes the orchestration
 * layer real rather than decorative: scan proposes, verify disposes, and rejected findings must
 * actually disappear from the output.
 */
let repo: string;

beforeAll(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "kalee-pipe-")));
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "buggy.ts"), "export function f(xs: number[]) {\n  return xs[xs.length];\n}\n");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

/** Replays scripted turns, keyed by which pass is asking. */
class Scripted implements ModelProvider {
  readonly kind = "scripted";
  readonly apiModel = "scripted";
  readonly pricing: Pricing = { input: 0, output: 0 };
  readonly caps: Capabilities = { ...DEFAULT_CAPS, nativeToolCalls: true, maxContext: 200_000 };
  calls = 0;

  constructor(
    readonly id: string,
    private script: (req: Request, n: number) => Block[],
  ) {}

  async *stream(req: Request): AsyncIterable<Event> {
    const blocks = this.script(req, this.calls++);
    for (const b of blocks) {
      if (b.type === "tool_call") yield { type: "tool_call_start", id: b.id, name: b.name };
      yield { type: "block_end", block: b };
    }
    yield {
      type: "turn_end",
      stop: blocks.some((b) => b.type === "tool_call") ? "tool_call" : "end_turn",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    };
  }

  async countTokens(): Promise<number> {
    return 500;
  }
}

const finding = (line: number, summary: string): Block => ({
  type: "tool_call",
  id: `rf${line}`,
  name: "report_finding",
  input: {
    file: "src/buggy.ts",
    line,
    severity: "high",
    category: "correctness",
    summary,
    failureScenario: "Calling f([1,2,3]) indexes xs[3], which is undefined, so the caller gets undefined instead of 3.",
  },
});

const verdict = (v: string, rationale: string): Block => ({
  type: "tool_call",
  id: `v-${v}`,
  name: "verdict",
  input: { verdict: v, rationale },
});

async function run(scan: ModelProvider, verify: ModelProvider, opts: { skipVerify?: boolean } = {}) {
  const target = await resolveTarget({ kind: "path", path: "src" }, repo);
  const session = new Session("pipe-test", repo);
  const result = await review({
    target,
    scan,
    verify,
    cwd: repo,
    trace: nullTrace(),
    policy: readonlyPolicy(),
    session,
    effort: "low",
    skipVerify: opts.skipVerify,
  });
  await session.flush();
  await rm(join(repo, ".kalee"), { recursive: true, force: true });
  return result;
}

describe("review pipeline", () => {
  test("scan proposes and verify confirms", async () => {
    const scan = new Scripted("scan", (_r, n) =>
      n === 0 ? [finding(2, "Off-by-one: xs[xs.length] is always undefined")] : [{ type: "text", text: "done" }],
    );
    const verify = new Scripted("verify", () => [verdict("confirmed", "Read the code; xs[xs.length] is out of bounds.")]);

    const result = await run(scan, verify);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      file: "src/buggy.ts",
      line: 2,
      verdict: "confirmed",
    });
    expect(result.findings[0]!.rationale).toContain("out of bounds");
  });

  test("a rejected finding is dropped from the output entirely", async () => {
    const scan = new Scripted("scan", (_r, n) =>
      n === 0
        ? [finding(2, "Off-by-one"), finding(1, "The signature is wrong")]
        : [{ type: "text", text: "done" }],
    );
    // The verifier rejects the second claim.
    let seen = 0;
    const verify = new Scripted("verify", () =>
      seen++ === 0
        ? [verdict("confirmed", "Traced it; the index is out of bounds.")]
        : [verdict("rejected", "The signature is fine; the claim assumed a string parameter.")],
    );

    const result = await run(scan, verify);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.line).toBe(2);
    // Kept for the trace, but out of the report.
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]!.line).toBe(1);
  });

  test("the verifier gets a fresh context, not the scan transcript", async () => {
    let verifierSaw: Request | undefined;
    const scan = new Scripted("scan", (_r, n) =>
      n === 0 ? [finding(2, "Off-by-one somewhere")] : [{ type: "text", text: "done" }],
    );
    const verify = new Scripted("verify", (req) => {
      verifierSaw ??= req;
      return [verdict("confirmed", "Checked the code and it holds.")];
    });

    await run(scan, verify);
    expect(verifierSaw).toBeDefined();
    // One user turn: the claim. Inheriting the scan's reasoning would make it agree with itself.
    expect(verifierSaw!.turns).toHaveLength(1);
    const text = verifierSaw!.turns[0]!.blocks[0];
    expect(text?.type === "text" && text.text).toContain("Verify this claim");
    // And the verifier must not be able to report new findings.
    expect(verifierSaw!.tools.map((t) => t.name)).not.toContain("report_finding");
    expect(verifierSaw!.tools.map((t) => t.name)).toContain("verdict");
  });

  test("--no-verify returns candidates unverified rather than confirmed", async () => {
    const scan = new Scripted("scan", (_r, n) =>
      n === 0 ? [finding(2, "Off-by-one")] : [{ type: "text", text: "done" }],
    );
    const verify = new Scripted("verify", () => {
      throw new Error("the verifier must not run");
    });

    const result = await run(scan, verify, { skipVerify: true });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.verdict).toBe("plausible");
    expect(verify.calls).toBe(0);
  });

  test("a clean scan produces no findings and never calls the verifier", async () => {
    const scan = new Scripted("scan", () => [{ type: "text", text: "I found no defects." }]);
    const verify = new Scripted("verify", () => [verdict("confirmed", "unused")]);

    const result = await run(scan, verify);
    expect(result.findings).toHaveLength(0);
    expect(verify.calls).toBe(0);
  });

  test("a verifier failure degrades to plausible rather than dropping the finding", async () => {
    const scan = new Scripted("scan", (_r, n) =>
      n === 0 ? [finding(2, "Off-by-one")] : [{ type: "text", text: "done" }],
    );
    // Never calls `verdict`, so the pass ends with no verdict recorded.
    const verify = new Scripted("verify", () => [{ type: "text", text: "I am not sure." }]);

    const result = await run(scan, verify);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]!.verdict).toBe("plausible");
  });

  test("duplicate findings on the same line and category are deduped", async () => {
    const scan = new Scripted("scan", (_r, n) =>
      n === 0
        ? [finding(2, "Off-by-one, first report"), finding(2, "Off-by-one, said again")]
        : [{ type: "text", text: "done" }],
    );
    const verify = new Scripted("verify", () => [verdict("confirmed", "Holds; traced the index.")]);

    const result = await run(scan, verify);
    expect(result.findings).toHaveLength(1);
    expect(verify.calls).toBe(1);
  });
});
