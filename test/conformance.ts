import { expect } from "bun:test";
import {
  ProviderError,
  type Block,
  type Event,
  type Request,
  type Turn,
} from "../src/model/ir.ts";
import type { ModelProvider } from "../src/model/provider.ts";

/**
 * The provider conformance suite — one battery every adapter must pass.
 *
 * Built at M1 rather than last, deliberately: it is what makes a third and fourth wire format
 * cheap and safe to add. Retrofitting an abstraction after the core has grown around one
 * provider is the standard way this design fails.
 *
 * A new adapter = implement `ModelProvider`, run this. Runs against recorded fixtures in CI,
 * live on demand.
 */
export interface ConformanceCase {
  name: string;
  run(provider: ModelProvider): Promise<void>;
}

const TOOL = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};

export function baseRequest(over: Partial<Request> = {}): Request {
  return {
    system: [{ text: "You are a terse assistant.", cache: true }],
    turns: [{ role: "user", blocks: [{ type: "text", text: "Say: ready" }] }],
    tools: [],
    effort: "low",
    maxOutputTokens: 512,
    ...over,
  };
}

export async function collect(provider: ModelProvider, req: Request): Promise<Event[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 120_000);
  try {
    const out: Event[] = [];
    for await (const ev of provider.stream(req, ctl.signal)) out.push(ev);
    return out;
  } finally {
    clearTimeout(t);
  }
}

export const CASES: ConformanceCase[] = [
  {
    name: "streams text deltas and reports usage",
    async run(provider) {
      const events = await collect(provider, baseRequest());
      const deltas = events.filter((e) => e.type === "text_delta");
      expect(deltas.length).toBeGreaterThan(0);

      const end = events.at(-1);
      expect(end?.type).toBe("turn_end");
      if (end?.type !== "turn_end") throw new Error("unreachable");
      expect(end.usage.input).toBeGreaterThan(0);
      expect(end.usage.output).toBeGreaterThan(0);
      expect(end.stop).toBe("end_turn");
    },
  },
  {
    name: "emits a well-formed tool call",
    async run(provider) {
      const events = await collect(
        provider,
        baseRequest({
          tools: [TOOL],
          turns: [{ role: "user", blocks: [{ type: "text", text: "Weather in Paris? Use the tool." }] }],
        }),
      );

      const start = events.find((e) => e.type === "tool_call_start");
      expect(start).toBeDefined();
      if (start?.type !== "tool_call_start") throw new Error("unreachable");
      expect(start.name).toBe("get_weather");
      expect(start.id).toBeTruthy();

      const block = events
        .filter((e) => e.type === "block_end")
        .map((e) => (e as Extract<Event, { type: "block_end" }>).block)
        .find((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call");
      expect(block).toBeDefined();
      // The id on block_end must match the id on start, or results cannot be routed back.
      expect(block!.id).toBe(start.id);
      expect((block!.input as { city?: string }).city?.toLowerCase()).toContain("paris");

      const end = events.at(-1);
      if (end?.type !== "turn_end") throw new Error("expected turn_end last");
      expect(end.stop).toBe("tool_call");
    },
  },
  {
    name: "round-trips a tool result",
    async run(provider) {
      const first = await collect(
        provider,
        baseRequest({
          tools: [TOOL],
          turns: [{ role: "user", blocks: [{ type: "text", text: "Weather in Paris? Use the tool." }] }],
        }),
      );
      const assistantBlocks = first
        .filter((e) => e.type === "block_end")
        .map((e) => (e as Extract<Event, { type: "block_end" }>).block);
      const call = assistantBlocks.find(
        (b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call",
      );
      expect(call).toBeDefined();

      const turns: Turn[] = [
        { role: "user", blocks: [{ type: "text", text: "Weather in Paris? Use the tool." }] },
        { role: "assistant", blocks: assistantBlocks },
        {
          role: "user",
          blocks: [
            {
              type: "tool_result",
              id: call!.id,
              isError: false,
              content: [{ type: "text", text: "18C and raining" }],
            },
          ],
        },
      ];

      const second = await collect(provider, baseRequest({ tools: [TOOL], turns }));
      const text = second
        .filter((e) => e.type === "text_delta")
        .map((e) => (e as Extract<Event, { type: "text_delta" }>).text)
        .join("");
      // The model must have actually received the result, not just ended the turn.
      expect(text).toMatch(/18|rain/i);
    },
  },
  {
    name: "surfaces errors as typed ProviderError, not raw throws",
    async run(provider) {
      // An empty tool name is invalid on every backend, so this is a real 400 live and a
      // deterministic one against the fake server.
      const bad = baseRequest({
        tools: [{ name: "", description: "", parameters: { type: "object", properties: {} } }],
      });
      let caught: unknown;
      try {
        await collect(provider, bad);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ProviderError);
      const err = caught as ProviderError;
      expect(typeof err.kind).toBe("string");
      expect(typeof err.retryable).toBe("boolean");
    },
  },
  {
    name: "drops reasoning produced by a different provider or model",
    async run(provider) {
      // Replaying a foreign reasoning block is a hard API error; the adapter must strip it.
      const turns: Turn[] = [
        { role: "user", blocks: [{ type: "text", text: "Say: ready" }] },
        {
          role: "assistant",
          blocks: [
            {
              type: "reasoning",
              summary: "some other model's thinking",
              opaque: { provider: "not-this-one", model: "not-this-model", payload: { junk: true } },
            },
            { type: "text", text: "ready" },
          ],
        },
        { role: "user", blocks: [{ type: "text", text: "Say it again." }] },
      ];
      const events = await collect(provider, baseRequest({ turns }));
      const end = events.at(-1);
      expect(end?.type).toBe("turn_end");
    },
  },
  {
    name: "counts tokens without throwing",
    async run(provider) {
      const n = await provider.countTokens(baseRequest());
      expect(n).toBeGreaterThan(0);
    },
  },
];
