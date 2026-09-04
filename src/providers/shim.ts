import type { Event, Request, ToolDef } from "../model/ir.ts";
import type { Capabilities, ModelProvider, Pricing } from "../model/provider.ts";

const OPEN = "<tool_call>";
const CLOSE = "</tool_call>";

/**
 * Text tool-call protocol for models that cannot emit structured `tool_calls`.
 *
 * Many local models — `mlx_lm.server` in particular, where tool support depends entirely on
 * the model's chat template — describe a call in prose instead. A harness that assumes
 * native tool calling simply does not work against them.
 *
 * Core sees identical `Event`s either way.
 */
export class ShimProvider implements ModelProvider {
  readonly kind: string;
  readonly id: string;
  readonly apiModel: string;
  readonly caps: Capabilities;
  readonly pricing: Pricing;

  constructor(private inner: ModelProvider) {
    this.id = inner.id;
    this.apiModel = inner.apiModel;
    this.kind = `${inner.kind}+shim`;
    this.pricing = inner.pricing;
    // To everything above this line the model now has tool calls; it just gets them serially.
    this.caps = { ...inner.caps, nativeToolCalls: true, parallelToolCalls: false };
  }

  private rewrite(req: Request): Request {
    if (req.tools.length === 0) return { ...req, tools: [] };
    return {
      ...req,
      tools: [],
      // The protocol block is stable across a session, so it belongs in the cached prefix.
      system: [...req.system, { text: renderToolProtocol(req.tools), cache: true }],
      // Some models keep narrating after a call; stopping there saves the tokens.
      stopSequences: [...(req.stopSequences ?? []), CLOSE],
    };
  }

  async *stream(req: Request, signal: AbortSignal): AsyncIterable<Event> {
    const parser = new ShimParser();
    for await (const ev of this.inner.stream(this.rewrite(req), signal)) {
      switch (ev.type) {
        case "text_delta":
          yield* parser.push(ev.text);
          break;
        case "turn_end":
          yield* parser.flush();
          yield {
            type: "turn_end",
            // A stop sequence hit on CLOSE is a tool call, not the end of the turn.
            stop: parser.sawCall ? "tool_call" : ev.stop,
            usage: ev.usage,
          };
          break;
        case "block_end":
          // Text blocks are reconstructed by the parser with tool-call regions removed.
          if (ev.block.type !== "text") yield ev;
          break;
        default:
          yield ev;
      }
    }
  }

  countTokens(req: Request): Promise<number> {
    return this.inner.countTokens(this.rewrite(req));
  }
}

/**
 * Incremental scanner over the text stream.
 *
 * The whole point is chunk boundaries: a tag split mid-token must not leak into user-visible
 * text, so any trailing text that could still become an opening tag is held back until the
 * next chunk resolves it.
 */
export class ShimParser {
  private buf = "";
  private inCall = false;
  private call = "";
  private text = "";
  private n = 0;
  sawCall = false;

  *push(chunk: string): Generator<Event> {
    this.buf += chunk;
    for (;;) {
      if (!this.inCall) {
        const i = this.buf.indexOf(OPEN);
        if (i === -1) {
          // Hold back a possible partial opening tag; emit everything safely before it.
          const keep = partialSuffix(this.buf, OPEN);
          const emit = this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          if (emit) {
            this.text += emit;
            yield { type: "text_delta", text: emit };
          }
          return;
        }
        const emit = this.buf.slice(0, i);
        if (emit) {
          this.text += emit;
          yield { type: "text_delta", text: emit };
        }
        this.buf = this.buf.slice(i + OPEN.length);
        this.inCall = true;
        this.call = "";
      } else {
        const j = this.buf.indexOf(CLOSE);
        if (j === -1) {
          // Buffer the call body; a partial closing tag must not be treated as body either.
          const keep = partialSuffix(this.buf, CLOSE);
          this.call += this.buf.slice(0, this.buf.length - keep);
          this.buf = this.buf.slice(this.buf.length - keep);
          return;
        }
        this.call += this.buf.slice(0, j);
        this.buf = this.buf.slice(j + CLOSE.length);
        this.inCall = false;
        yield* this.emitCall();
      }
    }
  }

  *flush(): Generator<Event> {
    if (this.inCall) {
      // Truncated call (stop sequence, max tokens): take what we have — the JSON often
      // completed even when the closing tag did not.
      this.call += this.buf;
      this.buf = "";
      this.inCall = false;
      yield* this.emitCall();
    } else if (this.buf) {
      this.text += this.buf;
      yield { type: "text_delta", text: this.buf };
      this.buf = "";
    }
    if (this.text.trim()) yield { type: "block_end", block: { type: "text", text: this.text } };
    this.text = "";
  }

  private *emitCall(): Generator<Event> {
    const parsed = parseCall(this.call);
    this.call = "";
    if (!parsed) return; // malformed: treated as prose, dropped rather than half-dispatched
    this.sawCall = true;
    const id = `shim_${++this.n}`;
    const json = JSON.stringify(parsed.input);
    yield { type: "tool_call_start", id, name: parsed.name };
    yield { type: "tool_call_delta", id, json };
    yield { type: "block_end", block: { type: "tool_call", id, name: parsed.name, input: parsed.input } };
  }
}

/** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
function partialSuffix(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (s.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

function parseCall(body: string): { name: string; input: unknown } | null {
  const raw = body.trim().replace(/^```(?:json)?/, "").replace(/```$/, "").trim();
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    // Small models like to append a stray token after the closing brace.
    const end = raw.lastIndexOf("}");
    if (end === -1) return null;
    try {
      obj = JSON.parse(raw.slice(0, end + 1));
    } catch {
      return null;
    }
  }
  const o = obj as { name?: unknown; input?: unknown; arguments?: unknown; parameters?: unknown };
  if (typeof o?.name !== "string") return null;
  const input = o.input ?? o.arguments ?? o.parameters ?? {};
  return { name: o.name, input: typeof input === "string" ? safeParse(input) : input };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function renderToolProtocol(tools: ToolDef[]): string {
  const list = tools
    .map((t) => `### ${t.name}\n${t.description}\n\nInput schema:\n${JSON.stringify(t.parameters)}`)
    .join("\n\n");
  return `# Tool use

You can call tools. To call one, emit EXACTLY this, and nothing else on those lines:

${OPEN}{"name": "<tool name>", "input": {<arguments>}}${CLOSE}

Rules:
- One call per block. Emit the block and then stop; the result comes back in the next message.
- The block must contain a single JSON object. No prose, no markdown fences inside it.
- Never invent a tool. Only the tools below exist.
- Do not describe a call in prose — a described call does not run.

## Available tools

${list}`;
}
