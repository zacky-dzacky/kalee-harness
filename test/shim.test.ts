import { describe, expect, test } from "bun:test";
import { ShimParser, ShimProvider, renderToolProtocol } from "../src/providers/shim.ts";
import type { Event, Request } from "../src/model/ir.ts";
import type { Capabilities, ModelProvider, Pricing } from "../src/model/provider.ts";
import { DEFAULT_CAPS } from "../src/model/provider.ts";

/**
 * The shim's contract: core must see byte-identical `Event`s whether the tool call arrived
 * natively or as prose. The interesting case is always the chunk boundary.
 */
function drain(parser: ShimParser, chunks: string[]): Event[] {
  const out: Event[] = [];
  for (const c of chunks) out.push(...parser.push(c));
  out.push(...parser.flush());
  return out;
}

const CALL = '<tool_call>{"name": "read_file", "input": {"path": "src/a.ts"}}</tool_call>';

describe("ShimParser", () => {
  test("parses a call arriving in one chunk", () => {
    const events = drain(new ShimParser(), [`Let me look. ${CALL}`]);
    const start = events.find((e) => e.type === "tool_call_start");
    expect(start).toMatchObject({ type: "tool_call_start", name: "read_file" });
    const block = events.find((e) => e.type === "block_end" && e.block.type === "tool_call");
    expect(block).toBeDefined();
    if (block?.type !== "block_end" || block.block.type !== "tool_call") throw new Error("bad");
    expect(block.block.input).toEqual({ path: "src/a.ts" });
  });

  test("emits identical events however the stream is split", () => {
    const whole = drain(new ShimParser(), [`Looking. ${CALL} done`]);
    // Every possible split point must produce the same events — including splits that land
    // inside the opening tag, inside the JSON, and inside the closing tag.
    const source = `Looking. ${CALL} done`;
    for (let i = 1; i < source.length; i++) {
      const split = drain(new ShimParser(), [source.slice(0, i), source.slice(i)]);
      expect(collapse(split)).toEqual(collapse(whole));
    }
  });

  test("splits one character at a time and still finds the call", () => {
    const source = `prose ${CALL} more prose`;
    const events = drain(new ShimParser(), [...source]);
    expect(collapse(events)).toEqual(collapse(drain(new ShimParser(), [source])));
  });

  test("never leaks a partial opening tag into visible text", () => {
    // "<tool_" alone must be held back, not shown to the user.
    const parser = new ShimParser();
    const first = [...parser.push("here it comes <tool_")];
    const text = first
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as Extract<Event, { type: "text_delta" }>).text)
      .join("");
    expect(text).toBe("here it comes ");
    expect(text).not.toContain("<tool_");
  });

  test("suppresses the tool-call region from visible text", () => {
    const events = drain(new ShimParser(), [`before ${CALL} after`]);
    const text = events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as Extract<Event, { type: "text_delta" }>).text)
      .join("");
    expect(text).toBe("before  after");
    expect(text).not.toContain("read_file");
  });

  test("handles two calls in one stream", () => {
    const events = drain(new ShimParser(), [`${CALL}\n${CALL}`]);
    expect(events.filter((e) => e.type === "tool_call_start")).toHaveLength(2);
  });

  test("recovers a call truncated by a stop sequence", () => {
    // The closing tag is a stop sequence, so the model's output often ends without it.
    const parser = new ShimParser();
    const events = drain(parser, ['<tool_call>{"name":"glob","input":{"pattern":"*.ts"}}']);
    expect(events.find((e) => e.type === "tool_call_start")).toBeDefined();
    expect(parser.sawCall).toBe(true);
  });

  test("treats malformed JSON as prose rather than dispatching half a call", () => {
    const parser = new ShimParser();
    const events = drain(parser, ["<tool_call>not json at all</tool_call>"]);
    expect(events.find((e) => e.type === "tool_call_start")).toBeUndefined();
    expect(parser.sawCall).toBe(false);
  });

  test("accepts `arguments` as an alias for `input`", () => {
    const events = drain(new ShimParser(), [
      '<tool_call>{"name":"grep","arguments":{"pattern":"foo"}}</tool_call>',
    ]);
    const block = events.find((e) => e.type === "block_end" && e.block.type === "tool_call");
    if (block?.type !== "block_end" || block.block.type !== "tool_call") throw new Error("bad");
    expect(block.block.input).toEqual({ pattern: "foo" });
  });
});

/** Compare on shape, ignoring how text deltas happened to be chunked. */
function collapse(events: Event[]): unknown[] {
  const out: unknown[] = [];
  let text = "";
  for (const e of events) {
    if (e.type === "text_delta") {
      text += e.text;
      continue;
    }
    if (text) {
      out.push({ type: "text", text });
      text = "";
    }
    out.push(e);
  }
  if (text) out.push({ type: "text", text });
  return out;
}

// --- the wrapper itself -------------------------------------------------------

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly kind = "scripted";
  readonly apiModel = "scripted";
  readonly caps: Capabilities = { ...DEFAULT_CAPS, nativeToolCalls: false };
  readonly pricing: Pricing = { input: 0, output: 0 };
  lastRequest?: Request;

  constructor(private text: string) {}

  async *stream(req: Request): AsyncIterable<Event> {
    this.lastRequest = req;
    for (const ch of chunk(this.text, 7)) yield { type: "text_delta", text: ch };
    yield { type: "block_end", block: { type: "text", text: this.text } };
    yield {
      type: "turn_end",
      stop: "end_turn",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    };
  }

  async countTokens(): Promise<number> {
    return 1;
  }
}

function chunk(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out;
}

const req = (): Request => ({
  system: [{ text: "system", cache: true }],
  turns: [{ role: "user", blocks: [{ type: "text", text: "read a file" }] }],
  tools: [
    {
      name: "read_file",
      description: "Read a file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  ],
  effort: "low",
  maxOutputTokens: 100,
});

describe("ShimProvider", () => {
  test("presents itself as tool-capable so the loop needs no special case", () => {
    const p = new ShimProvider(new ScriptedProvider("hi"));
    expect(p.caps.nativeToolCalls).toBe(true);
    expect(p.caps.parallelToolCalls).toBe(false);
  });

  test("turns prose into a tool call and reports stop: tool_call", async () => {
    const inner = new ScriptedProvider(`I'll read it. ${CALL}`);
    const p = new ShimProvider(inner);
    const events: Event[] = [];
    for await (const e of p.stream(req(), new AbortController().signal)) events.push(e);

    const start = events.find((e) => e.type === "tool_call_start");
    expect(start).toMatchObject({ name: "read_file" });
    const end = events.at(-1);
    if (end?.type !== "turn_end") throw new Error("expected turn_end");
    // The inner provider said end_turn; the shim must correct that to tool_call.
    expect(end.stop).toBe("tool_call");
    expect(end.usage.input).toBe(10);
  });

  test("moves tool schemas into the system prompt and clears the tools array", async () => {
    const inner = new ScriptedProvider("nothing to do");
    const p = new ShimProvider(inner);
    for await (const _ of p.stream(req(), new AbortController().signal)) void _;

    expect(inner.lastRequest?.tools).toEqual([]);
    const sys = inner.lastRequest?.system.map((s) => s.text).join("\n") ?? "";
    expect(sys).toContain("read_file");
    expect(sys).toContain("<tool_call>");
    // The protocol block is stable, so it must sit inside the cached prefix.
    expect(inner.lastRequest?.system.at(-1)?.cache).toBe(true);
    expect(inner.lastRequest?.stopSequences).toContain("</tool_call>");
  });

  test("renders every tool into the protocol block", () => {
    const rendered = renderToolProtocol(req().tools);
    expect(rendered).toContain("### read_file");
    expect(rendered).toContain('"path"');
  });
});
