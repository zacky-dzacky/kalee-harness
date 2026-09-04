import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { DEFAULT_CAPS } from "../src/model/provider.ts";
import { ContextBuilder } from "../src/core/context.ts";
import type { ModelEntry } from "../src/model/registry.ts";
import type { Request } from "../src/model/ir.ts";

/**
 * Cache regression test.
 *
 * Silent cache invalidators are invisible and expensive — nothing fails, the bill just doubles
 * — so only an assertion catches them. This runs offline against a server that reports what it
 * actually received; the live variant (`KALEE_LIVE_CACHE=1`) asserts cache-read tokens > 0 on
 * the second turn against the real API.
 */
let server: ReturnType<typeof Bun.serve>;
let bodies: Record<string, unknown>[] = [];

beforeAll(() => {
  process.env.ANTHROPIC_API_KEY = "test";
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      bodies.push(body);
      const frames = [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: { usage: { input_tokens: 5, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 } },
        })}\n\n`,
        `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n`,
        `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ];
      return new Response(frames.join(""), { headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterAll(() => server.stop(true));

function provider() {
  const entry: ModelEntry = {
    id: "test",
    provider: "anthropic",
    apiModel: "claude-test",
    baseURL: `http://localhost:${server.port}`,
    pricing: { input: 1, output: 1, cacheRead: 0.1 },
    caps: { ...DEFAULT_CAPS, explicitCacheBreakpoints: true, reasoning: "none", maxContext: 200_000 },
  };
  return new AnthropicProvider(entry);
}

async function run(req: Request) {
  const ctl = new AbortController();
  const events = [];
  for await (const e of provider().stream(req, ctl.signal)) events.push(e);
  return events;
}

const request = (userText: string): Request => ({
  system: new ContextBuilder().identity("STABLE IDENTITY").addStable("STABLE REPO MAP").build(),
  turns: [{ role: "user", blocks: [{ type: "text", text: userText }] }],
  tools: [],
  effort: "low",
  maxOutputTokens: 100,
});

describe("prompt caching", () => {
  test("sets a cache_control breakpoint on the stable prefix", async () => {
    bodies = [];
    await run(request("first question"));
    const system = bodies[0]!.system as { text: string; cache_control?: unknown }[];
    expect(system).toHaveLength(1);
    expect(system[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("the cached prefix is byte-identical across turns", async () => {
    bodies = [];
    await run(request("first question"));
    await run(request("a completely different second question"));

    const a = bodies[0]!.system as { text: string }[];
    const b = bodies[1]!.system as { text: string }[];
    // If this drifts, caching silently stops hitting and nothing else fails.
    expect(b[0]!.text).toBe(a[0]!.text);
    expect(JSON.stringify(bodies[1]!.messages)).not.toBe(JSON.stringify(bodies[0]!.messages));
  });

  test("reports cache-read tokens from the response", async () => {
    bodies = [];
    const events = await run(request("q"));
    const end = events.at(-1);
    if (end?.type !== "turn_end") throw new Error("expected turn_end");
    expect(end.usage.cacheRead).toBe(900);
  });

  test("omits cache_control when the model has no explicit breakpoints", async () => {
    bodies = [];
    const entry: ModelEntry = {
      id: "nocache", provider: "anthropic", apiModel: "m",
      baseURL: `http://localhost:${server.port}`,
      pricing: { input: 1, output: 1 },
      caps: { ...DEFAULT_CAPS, explicitCacheBreakpoints: false, reasoning: "none" },
    };
    const p = new AnthropicProvider(entry);
    for await (const _ of p.stream(request("q"), new AbortController().signal)) void _;
    const system = bodies[0]!.system as { cache_control?: unknown }[];
    expect(system[0]!.cache_control).toBeUndefined();
  });
});

// The live variant: opt in with KALEE_LIVE_CACHE=1 and a real key.
const live = process.env.KALEE_LIVE_CACHE === "1" ? describe : describe.skip;
live("prompt caching (live)", () => {
  test("cache-read tokens are greater than zero on the second turn", async () => {
    const { loadRegistry, resolveRole } = await import("../src/model/registry.ts");
    const { makeProvider } = await import("../src/providers/index.ts");
    const reg = await loadRegistry(process.cwd());
    const p = makeProvider(resolveRole(reg, "scan"));

    // The prefix must exceed the provider's minimum cacheable length to be cached at all.
    const filler = "You are a careful code reviewer. ".repeat(400);
    const req = (q: string): Request => ({
      system: new ContextBuilder().identity(filler).build(),
      turns: [{ role: "user", blocks: [{ type: "text", text: q }] }],
      tools: [],
      effort: "low",
      maxOutputTokens: 32,
    });

    const drain = async (r: Request) => {
      let usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for await (const e of p.stream(r, new AbortController().signal)) {
        if (e.type === "turn_end") usage = e.usage;
      }
      return usage;
    };

    await drain(req("Say A"));
    const second = await drain(req("Say B"));
    expect(second.cacheRead).toBeGreaterThan(0);
  }, 120_000);
});
