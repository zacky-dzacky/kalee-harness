import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { Block, Event, Request } from "../src/model/ir.ts";
import { DEFAULT_CAPS, type Capabilities, type ModelProvider, type Pricing } from "../src/model/provider.ts";
import { runLoop } from "../src/core/loop.ts";
import { Session } from "../src/core/session.ts";
import { nullTrace } from "../src/core/trace.ts";
import { Policy, readonlyPolicy } from "../src/core/policy.ts";
import { ToolRegistry } from "../src/tools/index.ts";
import { ok, type Tool } from "../src/tools/types.ts";

/** A provider that replays a script of turns, so the loop can be tested without a network. */
class ScriptProvider implements ModelProvider {
  readonly id = "script";
  readonly kind = "script";
  readonly apiModel = "script";
  readonly pricing: Pricing = { input: 1, output: 1 };
  readonly caps: Capabilities;
  requests: Request[] = [];
  private turn = 0;

  constructor(
    private script: Block[][],
    caps: Partial<Capabilities> = {},
  ) {
    this.caps = { ...DEFAULT_CAPS, nativeToolCalls: true, ...caps };
  }

  async *stream(req: Request): AsyncIterable<Event> {
    this.requests.push(structuredClone(req));
    const blocks = this.script[this.turn++] ?? [{ type: "text" as const, text: "done" }];
    for (const b of blocks) {
      if (b.type === "text") yield { type: "text_delta", text: b.text };
      if (b.type === "tool_call") yield { type: "tool_call_start", id: b.id, name: b.name };
      yield { type: "block_end", block: b };
    }
    yield {
      type: "turn_end",
      stop: blocks.some((b) => b.type === "tool_call") ? "tool_call" : "end_turn",
      usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 },
    };
  }

  async countTokens(): Promise<number> {
    return 100;
  }
}

const call = (id: string, name: string, input: unknown): Block => ({ type: "tool_call", id, name, input });

function tracker(name: string, opts: { parallelSafe?: boolean; delayMs?: number; throws?: boolean } = {}) {
  const calls: unknown[] = [];
  const active: number[] = [];
  let maxConcurrent = 0;
  const tool: Tool = {
    name,
    description: `test tool ${name}`,
    schema: z.object({ value: z.string() }),
    effect: "read-only",
    parallelSafe: opts.parallelSafe ?? true,
    async call(input) {
      calls.push(input);
      active.push(1);
      maxConcurrent = Math.max(maxConcurrent, active.length);
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      active.pop();
      if (opts.throws) throw new Error("tool exploded");
      return ok(`${name} ok`);
    },
  };
  return { tool, calls, get maxConcurrent() { return maxConcurrent; } };
}

const base = (provider: ModelProvider, tools: Tool[]) => {
  const session = new Session("test", "/tmp/kalee-test-noop");
  session.flush = async () => {};
  session.append = ((orig) => (turn: Parameters<typeof orig>[0], pass?: string) => {
    // Keep the in-memory transcript, skip the disk write.
    (session as unknown as { turns: unknown[] }).turns.push(turn);
    void pass;
  })(session.append.bind(session)) as typeof session.append;
  return {
    provider,
    tools: new ToolRegistry(tools),
    system: [{ text: "system", cache: true }],
    session,
    trace: nullTrace(),
    policy: readonlyPolicy(),
    cwd: process.cwd(),
    pass: "test",
  };
};

describe("agent loop", () => {
  test("returns all tool results in ONE user turn", async () => {
    const a = tracker("alpha");
    const b = tracker("beta");
    const provider = new ScriptProvider(
      [
        [call("1", "alpha", { value: "x" }), call("2", "beta", { value: "y" })],
        [{ type: "text", text: "finished" }],
      ],
      { parallelToolCalls: true },
    );

    await runLoop({ ...base(provider, [a.tool, b.tool]) });

    // Splitting results across turns teaches the model to stop calling tools in parallel.
    const second = provider.requests[1]!;
    const userTurns = second.turns.filter((t) => t.role === "user");
    const resultTurns = userTurns.filter((t) => t.blocks.some((bl) => bl.type === "tool_result"));
    expect(resultTurns).toHaveLength(1);
    expect(resultTurns[0]!.blocks.filter((bl) => bl.type === "tool_result")).toHaveLength(2);
  });

  test("fans out when the model and every tool are parallel-safe", async () => {
    const a = tracker("alpha", { delayMs: 60 });
    const b = tracker("beta", { delayMs: 60 });
    const provider = new ScriptProvider(
      [[call("1", "alpha", { value: "x" }), call("2", "beta", { value: "y" })], [{ type: "text", text: "ok" }]],
      { parallelToolCalls: true },
    );
    await runLoop({ ...base(provider, [a.tool, b.tool]) });
    expect(a.maxConcurrent + b.maxConcurrent).toBeGreaterThan(1);
  });

  test("serializes when the model cannot do parallel tool calls", async () => {
    const a = tracker("alpha", { delayMs: 40 });
    const b = tracker("beta", { delayMs: 40 });
    const provider = new ScriptProvider(
      [[call("1", "alpha", { value: "x" }), call("2", "beta", { value: "y" })], [{ type: "text", text: "ok" }]],
      { parallelToolCalls: false },
    );
    await runLoop({ ...base(provider, [a.tool, b.tool]) });
    expect(a.maxConcurrent).toBe(1);
    expect(b.maxConcurrent).toBe(1);
  });

  test("serializes when any single tool is not parallel-safe", async () => {
    const a = tracker("alpha", { delayMs: 40, parallelSafe: true });
    const b = tracker("beta", { delayMs: 40, parallelSafe: false });
    const provider = new ScriptProvider(
      [[call("1", "alpha", { value: "x" }), call("2", "beta", { value: "y" })], [{ type: "text", text: "ok" }]],
      { parallelToolCalls: true },
    );
    await runLoop({ ...base(provider, [a.tool, b.tool]) });
    expect(a.maxConcurrent).toBe(1);
  });

  test("a throwing tool returns an error result and never drops it", async () => {
    const boom = tracker("boom", { throws: true });
    const provider = new ScriptProvider([
      [call("1", "boom", { value: "x" })],
      [{ type: "text", text: "recovered" }],
    ]);
    const result = await runLoop({ ...base(provider, [boom.tool]) });

    const results = provider.requests[1]!.turns.flatMap((t) =>
      t.blocks.filter((bl) => bl.type === "tool_result"),
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ isError: true });
    expect(result.text).toBe("recovered");
  });

  test("an unknown tool name comes back as an error listing the real tools", async () => {
    const a = tracker("alpha");
    const provider = new ScriptProvider([
      [call("1", "nonexistent", {})],
      [{ type: "text", text: "ok" }],
    ]);
    await runLoop({ ...base(provider, [a.tool]) });
    const results = provider.requests[1]!.turns.flatMap((t) =>
      t.blocks.filter((bl) => bl.type === "tool_result"),
    );
    const text = results[0]!.type === "tool_result" ? results[0]!.content[0] : undefined;
    expect(text?.type === "text" && text.text).toContain("alpha");
  });

  test("invalid tool arguments come back as a usable message, not a stack trace", async () => {
    const a = tracker("alpha");
    const provider = new ScriptProvider([
      [call("1", "alpha", { wrong: 1 })],
      [{ type: "text", text: "ok" }],
    ]);
    await runLoop({ ...base(provider, [a.tool]) });
    const results = provider.requests[1]!.turns.flatMap((t) =>
      t.blocks.filter((bl) => bl.type === "tool_result"),
    );
    const block = results[0];
    if (block?.type !== "tool_result") throw new Error("expected a tool_result");
    const text = block.content[0];
    expect(text?.type === "text" && text.text).toMatch(/invalid arguments/);
  });

  test("a denied tool returns a permission error instead of running", async () => {
    const a = tracker("alpha");
    const denyAll = new Policy({ mode: "deny" });
    const provider = new ScriptProvider([
      [call("1", "alpha", { value: "x" })],
      [{ type: "text", text: "ok" }],
    ]);
    await runLoop({ ...base(provider, [a.tool]), policy: denyAll });
    expect(a.calls).toHaveLength(0);
    const results = provider.requests[1]!.turns.flatMap((t) =>
      t.blocks.filter((bl) => bl.type === "tool_result"),
    );
    const block = results[0];
    if (block?.type !== "tool_result") throw new Error("expected a tool_result");
    const text = block.content[0];
    expect(text?.type === "text" && text.text).toMatch(/permission denied/);
  });

  test("stops at the turn cap and reports why", async () => {
    const a = tracker("alpha");
    // A model that calls a tool forever.
    const provider = new ScriptProvider(
      Array.from({ length: 20 }, () => [call(`x`, "alpha", { value: "x" })]),
    );
    const result = await runLoop({
      ...base(provider, [a.tool]),
      limits: { maxTurns: 3, maxTokens: 1e9, maxWallClockMs: 60_000, maxCostUsd: 100 },
    });
    expect(result.haltReason).toMatch(/turn cap/);
    expect(provider.requests).toHaveLength(3);
  });

  test("accumulates usage and cost across turns", async () => {
    const a = tracker("alpha");
    const provider = new ScriptProvider([
      [call("1", "alpha", { value: "x" })],
      [{ type: "text", text: "done" }],
    ]);
    const result = await runLoop({ ...base(provider, [a.tool]) });
    expect(result.usage.input).toBe(200);
    expect(result.usage.output).toBe(40);
    // $1/MTok each way: 200 in + 40 out.
    expect(result.costUsd).toBeCloseTo(240 / 1_000_000, 9);
  });

  test("forwards structured tool emissions to the caller", async () => {
    const emitted: unknown[] = [];
    const emitter: Tool = {
      name: "emitter",
      description: "emits",
      schema: z.object({ v: z.string() }),
      effect: "read-only",
      parallelSafe: true,
      async call(input, ctx) {
        ctx.emit?.("finding", input);
        return ok("emitted");
      },
    };
    const provider = new ScriptProvider([
      [call("1", "emitter", { v: "hello" })],
      [{ type: "text", text: "ok" }],
    ]);
    await runLoop({
      ...base(provider, [emitter]),
      onEmit: (kind, value) => kind === "finding" && emitted.push(value),
    });
    expect(emitted).toEqual([{ v: "hello" }]);
  });
});
