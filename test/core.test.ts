import { describe, expect, test } from "bun:test";
import { ContextBuilder } from "../src/core/context.ts";
import { manifest, parseSkill } from "../src/core/skills.ts";
import { Budget } from "../src/core/budget.ts";
import { resolveRole, type Registry } from "../src/model/registry.ts";
import { costOf, DEFAULT_CAPS } from "../src/model/provider.ts";
import { addUsage, emptyUsage, filterReasoning, systemText, type Turn } from "../src/model/ir.ts";
import { dedupe, rank, type Finding } from "../src/review/finding.ts";
import { aggregate, score, type Expected } from "../src/eval/score.ts";
import { toJsonSchema, defaultRegistry, reviewRegistry } from "../src/tools/index.ts";

describe("ContextBuilder", () => {
  test("puts stable content in a cached span and volatile content after it", () => {
    const spans = new ContextBuilder()
      .identity("IDENTITY")
      .addStable("REPO MAP")
      .addVolatile("TODAY IS TUESDAY")
      .build();

    expect(spans).toHaveLength(2);
    expect(spans[0]!.cache).toBe(true);
    expect(spans[0]!.text).toContain("IDENTITY");
    expect(spans[0]!.text).toContain("REPO MAP");
    // Volatile content after the breakpoint, or the prefix changes every run and the cache
    // silently never hits.
    expect(spans[0]!.text).not.toContain("TUESDAY");
    expect(spans[1]!.cache).toBeUndefined();
  });

  test("refuses to add stable content after volatile content", () => {
    const b = new ContextBuilder().addStable("A").addVolatile("B");
    expect(() => b.addStable("C")).toThrow(/cache prefix/);
  });

  test("skips empty sections", () => {
    const spans = new ContextBuilder().identity("X").overlay(null).addStable("  ").build();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe("X");
  });
});

describe("skills", () => {
  const source = `---
name: code-review
description: Review a diff.
tools: [read_file, grep]
---

# Body

Do the thing.`;

  test("parses frontmatter and body", () => {
    const s = parseSkill(source, "SKILL.md");
    expect(s.name).toBe("code-review");
    expect(s.tools).toEqual(["read_file", "grep"]);
    expect(s.body).toContain("Do the thing");
    // The body must not leak into the description that sits in context.
    expect(s.description).not.toContain("Body");
  });

  test("requires name and description", () => {
    expect(() => parseSkill("---\ndescription: x\n---\nbody", "S")).toThrow(/name/);
    expect(() => parseSkill("---\nname: x\n---\nbody", "S")).toThrow(/description/);
    expect(() => parseSkill("no frontmatter", "S")).toThrow(/frontmatter/);
  });

  test("the manifest carries descriptions only — progressive disclosure", () => {
    const s = parseSkill(source, "S");
    const m = manifest([s]);
    expect(m).toContain("Review a diff.");
    expect(m).not.toContain("Do the thing");
  });
});

describe("budget", () => {
  test("stops before spending past the turn cap", () => {
    const b = new Budget({ maxTurns: 2, maxTokens: 1e9, maxWallClockMs: 1e9, maxCostUsd: 1e9 });
    expect(b.startTurn().exhausted).toBe(false);
    expect(b.startTurn().exhausted).toBe(false);
    expect(b.startTurn()).toMatchObject({ exhausted: true });
  });

  test("stops on the cost cap", () => {
    const b = new Budget({ maxTurns: 100, maxTokens: 1e9, maxWallClockMs: 1e9, maxCostUsd: 0.5 });
    b.startTurn();
    b.spend(emptyUsage(), 0.6);
    expect(b.startTurn()).toMatchObject({ exhausted: true, reason: expect.stringMatching(/cost/) });
  });

  test("stops on the token cap", () => {
    const b = new Budget({ maxTurns: 100, maxTokens: 1000, maxWallClockMs: 1e9, maxCostUsd: 1e9 });
    b.startTurn();
    b.spend({ input: 900, output: 200, cacheRead: 0, cacheWrite: 0 }, 0);
    expect(b.startTurn()).toMatchObject({ exhausted: true, reason: expect.stringMatching(/token/) });
  });
});

describe("registry role resolution", () => {
  const reg: Registry = {
    path: "test",
    models: [
      { id: "big", provider: "anthropic", apiModel: "b", pricing: { input: 1, output: 1 }, caps: DEFAULT_CAPS },
      { id: "small", provider: "openai", apiModel: "s", pricing: { input: 0, output: 0 }, caps: DEFAULT_CAPS },
    ],
    roles: { scan: "big", verify: "small", default: "big" },
  };

  test("resolves each role from the registry", () => {
    expect(resolveRole(reg, "scan").id).toBe("big");
    expect(resolveRole(reg, "verify").id).toBe("small");
  });

  test("--model overrides every role", () => {
    expect(resolveRole(reg, "scan", { model: "small" }).id).toBe("small");
    expect(resolveRole(reg, "verify", { model: "small" }).id).toBe("small");
  });

  test("a per-role override beats --model", () => {
    expect(resolveRole(reg, "scan", { model: "small", roleModels: { scan: "big" } }).id).toBe("big");
  });

  test("an unknown model names the ones that exist", () => {
    expect(() => resolveRole(reg, "scan", { model: "nope" })).toThrow(/big, small/);
  });
});

describe("IR helpers", () => {
  test("costOf uses cacheRead pricing where given", () => {
    const cost = costOf(
      { input: 5, output: 25, cacheRead: 0.5 },
      { input: 1_000_000, output: 0, cacheRead: 1_000_000, cacheWrite: 0 },
    );
    expect(cost).toBeCloseTo(5.5, 6);
  });

  test("filterReasoning keeps same-model reasoning and drops the rest", () => {
    const turns: Turn[] = [
      {
        role: "assistant",
        blocks: [
          { type: "reasoning", opaque: { provider: "anthropic", model: "opus", payload: 1 } },
          { type: "reasoning", opaque: { provider: "openai", model: "gpt", payload: 2 } },
          { type: "reasoning", summary: "no payload" },
          { type: "text", text: "hi" },
        ],
      },
    ];
    const kept = filterReasoning(turns, "anthropic", "opus")[0]!.blocks;
    expect(kept).toHaveLength(2);
    expect(kept[0]).toMatchObject({ type: "reasoning" });
    expect(kept[1]).toMatchObject({ type: "text" });
  });

  test("systemText joins spans in order", () => {
    expect(systemText([{ text: "a", cache: true }, { text: "b" }])).toBe("a\n\nb");
  });

  test("addUsage sums every field", () => {
    const sum = addUsage(
      { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
      { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 },
    );
    expect(sum).toMatchObject({ input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });
  });
});

describe("tool schemas", () => {
  test("every builtin produces an object JSON Schema with no $ref", () => {
    for (const tool of defaultRegistry().list()) {
      const schema = toJsonSchema(tool);
      expect(schema.type).toBe("object");
      // $refs break several backends' schema validators.
      expect(JSON.stringify(schema)).not.toContain("$ref");
      expect(schema.$schema).toBeUndefined();
    }
  });

  test("the review registry is read-only", () => {
    for (const t of reviewRegistry().list()) expect(t.effect).toBe("read-only");
    expect(reviewRegistry().get("bash")).toBeUndefined();
  });

  test("selecting an unknown tool fails loudly", () => {
    expect(() => reviewRegistry().select(["read_file", "nope"])).toThrow(/nope/);
  });
});

describe("finding ranking", () => {
  const f = (over: Partial<Finding>): Finding => ({
    id: "x", file: "a.ts", line: 1, severity: "medium", category: "correctness",
    summary: "s", failureScenario: "f", verdict: "plausible", ...over,
  });

  test("confirmed outranks plausible, then severity", () => {
    const ranked = rank([
      f({ verdict: "plausible", severity: "critical" }),
      f({ verdict: "confirmed", severity: "low" }),
      f({ verdict: "confirmed", severity: "high" }),
    ]);
    expect(ranked.map((x) => [x.verdict, x.severity])).toEqual([
      ["confirmed", "high"],
      ["confirmed", "low"],
      ["plausible", "critical"],
    ]);
  });

  test("dedupes by file, line and category, keeping the worst severity", () => {
    const out = dedupe([
      f({ severity: "low" }),
      f({ severity: "critical" }),
      f({ line: 2 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.find((x) => x.line === 1)!.severity).toBe("critical");
  });
});

describe("eval scoring", () => {
  const expected: Expected = {
    case: "t",
    description: "d",
    bugs: [{ file: "a.ts", line: 10, tolerance: 2, hint: "h" }],
    traps: [{ file: "a.ts", line: 50, why: "looks wrong but is fine" }],
  };
  const f = (line: number, file = "a.ts"): Finding => ({
    id: `l${line}`, file, line, severity: "high", category: "correctness",
    summary: "s", failureScenario: "f", verdict: "confirmed",
  });

  test("matches within tolerance", () => {
    const s = score(expected, [f(11)], { costUsd: 0, durationMs: 0 });
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
  });

  test("counts a finding outside tolerance as a miss and a false positive", () => {
    const s = score(expected, [f(30)], { costUsd: 0, durationMs: 0 });
    expect(s.recall).toBe(0);
    expect(s.falsePositives).toHaveLength(1);
  });

  test("flags a trap that was hit", () => {
    const s = score(expected, [f(10), f(50)], { costUsd: 0, durationMs: 0 });
    expect(s.recall).toBe(1);
    expect(s.trapsHit).toHaveLength(1);
  });

  test("a clean fixture with no findings scores perfectly", () => {
    const clean: Expected = { case: "c", description: "d", bugs: [] };
    const s = score(clean, [], { costUsd: 0, durationMs: 0 });
    expect(s.recall).toBe(1);
    expect(s.precision).toBe(1);
    expect(s.f1).toBe(1);
  });

  test("a clean fixture with a finding scores zero precision", () => {
    const clean: Expected = { case: "c", description: "d", bugs: [] };
    const s = score(clean, [f(3)], { costUsd: 0, durationMs: 0 });
    expect(s.precision).toBe(0);
    expect(s.falsePositives).toHaveLength(1);
  });

  test("one finding cannot satisfy two expected bugs", () => {
    const two: Expected = {
      case: "t", description: "d",
      bugs: [{ file: "a.ts", line: 10, hint: "h" }, { file: "a.ts", line: 11, hint: "h2" }],
    };
    const s = score(two, [f(10)], { costUsd: 0, durationMs: 0 });
    expect(s.matched).toHaveLength(1);
    expect(s.missed).toHaveLength(1);
  });

  test("matches paths that differ by a directory prefix", () => {
    const s = score(expected, [f(10, "repo/a.ts")], { costUsd: 0, durationMs: 0 });
    expect(s.recall).toBe(1);
  });

  test("aggregate micro-averages across cases", () => {
    const a = score(expected, [f(10)], { costUsd: 1, durationMs: 100 });
    const b = score(expected, [f(99)], { costUsd: 2, durationMs: 200 });
    const t = aggregate([a, b]);
    expect(t.cases).toBe(2);
    expect(t.recall).toBe(0.5);
    expect(t.costUsd).toBe(3);
  });
});
