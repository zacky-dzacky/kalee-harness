import { describe, expect, test } from "bun:test";
import { planBatches } from "../src/core/compact.ts";
import { estimateTokens, DEFAULT_CAPS, type Capabilities, type ModelProvider, type Pricing } from "../src/model/provider.ts";
import type { Event, Request } from "../src/model/ir.ts";
import { renderTarget, type FileChange, type ReviewTarget } from "../src/review/target.ts";

/** A provider that only exists to have a context window and a token counter. */
class SizedProvider implements ModelProvider {
  readonly id: string;
  readonly kind = "sized";
  readonly apiModel = "sized";
  readonly pricing: Pricing = { input: 0, output: 0 };
  readonly caps: Capabilities;

  constructor(maxContext: number) {
    this.id = `ctx-${maxContext}`;
    this.caps = { ...DEFAULT_CAPS, maxContext };
  }

  async *stream(): AsyncIterable<Event> {
    yield { type: "turn_end", stop: "end_turn", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  }

  async countTokens(req: Request): Promise<number> {
    return estimateTokens(req.system.map((s) => s.text).join("") + JSON.stringify(req.turns));
  }
}

/** ~`tokens` worth of plausible diff text. */
function fileOf(path: string, tokens: number): FileChange {
  const line = "+  const someValue = computeSomething(argument, another);\n";
  const repeats = Math.ceil((tokens * 3.6) / line.length);
  return {
    path,
    status: "modified",
    additions: repeats,
    deletions: 0,
    patch: `@@ -1,1 +1,${repeats} @@\n${line.repeat(repeats)}`,
  };
}

const target = (files: FileChange[]): ReviewTarget => ({
  kind: "range",
  label: "test",
  files,
  wholeFile: false,
});

const system = [{ text: "system prompt", cache: true }];

describe("context budgeting", () => {
  test("a diff that fits is a single pass", async () => {
    const files = [fileOf("a.ts", 1_000), fileOf("b.ts", 1_000)];
    const plan = await planBatches(
      new SizedProvider(200_000),
      system,
      files,
      (f) => renderTarget(target(files), f),
      8192,
    );
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]).toHaveLength(2);
  });

  test("a 60k-token diff degrades to per-file map-reduce on a 32k model", async () => {
    // The scenario from the plan: this must review, not fail.
    const files = Array.from({ length: 12 }, (_, i) => fileOf(`src/f${i}.ts`, 5_000));
    const provider = new SizedProvider(32_768);
    const plan = await planBatches(
      provider,
      system,
      files,
      (f) => renderTarget(target(files), f),
      4096,
    );

    expect(plan.batches.length).toBeGreaterThan(1);
    // Every file must land in exactly one batch — chunking that drops a file is worse than
    // failing, because it looks like a clean review.
    const seen = plan.batches.flat().map((f) => f.path);
    expect(seen.sort()).toEqual(files.map((f) => f.path).sort());
    expect(plan.reason).toMatch(/split into/);
  });

  test("a single oversized file still gets its own pass rather than being dropped", async () => {
    const files = [fileOf("huge.ts", 100_000)];
    const plan = await planBatches(
      new SizedProvider(32_768),
      system,
      files,
      (f) => renderTarget(target(files), f),
      4096,
    );
    expect(plan.batches).toHaveLength(1);
    expect(plan.batches[0]![0]!.path).toBe("huge.ts");
  });

  test("a context window too small for anything is an error, not silent truncation", async () => {
    const files = [fileOf("a.ts", 100)];
    await expect(
      planBatches(new SizedProvider(1000), system, files, (f) => renderTarget(target(files), f), 8192),
    ).rejects.toThrow(/too small/);
  });
});
