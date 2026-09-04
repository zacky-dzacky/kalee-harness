import Anthropic from "@anthropic-ai/sdk";
import {
  assertNever,
  emptyUsage,
  filterReasoning,
  ProviderError,
  type Block,
  type CacheSpan,
  type Event,
  type Request,
  type StopReason,
  type Turn,
  type Usage,
} from "../model/ir.ts";
import { estimateTokens, type Capabilities, type ModelProvider, type Pricing } from "../model/provider.ts";
import type { ModelEntry } from "../model/registry.ts";

const KIND = "anthropic";

/** Anthropic's effort knob is a thinking token budget. */
const THINKING_BUDGET: Record<Request["effort"], number> = {
  low: 0,
  medium: 4_000,
  high: 12_000,
  max: 32_000,
};

export class AnthropicProvider implements ModelProvider {
  readonly kind = KIND;
  readonly id: string;
  readonly apiModel: string;
  readonly caps: Capabilities;
  readonly pricing: Pricing;
  private client: Anthropic;

  constructor(entry: ModelEntry) {
    this.id = entry.id;
    this.apiModel = entry.apiModel;
    this.caps = entry.caps;
    this.pricing = entry.pricing;
    const apiKey = process.env[entry.apiKeyEnv ?? "ANTHROPIC_API_KEY"];
    if (!apiKey) {
      throw new ProviderError(
        `${entry.apiKeyEnv ?? "ANTHROPIC_API_KEY"} is not set`,
        "auth",
        KIND,
        false,
      );
    }
    this.client = new Anthropic({ apiKey, baseURL: entry.baseURL });
  }

  /** Cache breakpoints are explicit here: mark the last content block of a cached span. */
  private system(spans: CacheSpan[]): Anthropic.TextBlockParam[] {
    return spans
      .filter((s) => s.text.trim().length > 0)
      .map((s) => ({
        type: "text" as const,
        text: s.text,
        ...(s.cache && this.caps.explicitCacheBreakpoints
          ? { cache_control: { type: "ephemeral" as const } }
          : {}),
      }));
  }

  private blocks(blocks: Block[]): Anthropic.ContentBlockParam[] {
    const out: Anthropic.ContentBlockParam[] = [];
    for (const b of blocks) {
      switch (b.type) {
        case "text":
          if (b.text.length > 0) out.push({ type: "text", text: b.text });
          break;
        case "reasoning":
          // Only same-provider/same-model reasoning reaches here (filterReasoning);
          // the payload is the original signed block, replayed verbatim.
          if (b.opaque) out.push(b.opaque.payload as Anthropic.ContentBlockParam);
          break;
        case "tool_call":
          out.push({
            type: "tool_use",
            id: b.id,
            name: b.name,
            input: (b.input ?? {}) as Record<string, unknown>,
          });
          break;
        case "tool_result":
          out.push({
            type: "tool_result",
            tool_use_id: b.id,
            is_error: b.isError,
            content: b.content
              .filter((c): c is Extract<Block, { type: "text" }> => c.type === "text")
              .map((c) => ({ type: "text" as const, text: c.text })),
          });
          break;
        default:
          assertNever(b, "Block");
      }
    }
    return out;
  }

  private messages(turns: Turn[]): Anthropic.MessageParam[] {
    return filterReasoning(turns, KIND, this.apiModel)
      .map((t) => ({ role: t.role, content: this.blocks(t.blocks) }))
      .filter((m) => m.content.length > 0);
  }

  private body(req: Request): Anthropic.MessageCreateParamsStreaming {
    const budget = THINKING_BUDGET[req.effort];
    const thinking =
      this.caps.reasoning === "none" || budget === 0
        ? undefined
        : ({ type: "enabled", budget_tokens: budget } as const);
    return {
      model: this.apiModel,
      // Anthropic requires max_tokens > thinking budget.
      max_tokens: Math.max(req.maxOutputTokens, (thinking?.budget_tokens ?? 0) + 1024),
      system: this.system(req.system),
      messages: this.messages(req.turns),
      tools: req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Tool.InputSchema,
      })),
      stream: true,
      ...(thinking ? { thinking } : { temperature: req.temperature ?? 0 }),
      ...(req.stopSequences?.length ? { stop_sequences: req.stopSequences } : {}),
    };
  }

  async *stream(req: Request, signal: AbortSignal): AsyncIterable<Event> {
    let stream: Awaited<ReturnType<typeof this.client.messages.create>>;
    try {
      stream = await this.client.messages.create(this.body(req), { signal });
    } catch (e) {
      throw translate(e);
    }

    const usage: Usage = emptyUsage();
    let stop: StopReason = "end_turn";
    // Partial blocks accumulated by index, so `block_end` can carry a complete Block.
    const open = new Map<number, { block: Block; json: string }>();

    try {
      for await (const ev of stream as AsyncIterable<Anthropic.MessageStreamEvent>) {
        switch (ev.type) {
          case "message_start":
            usage.input += ev.message.usage.input_tokens ?? 0;
            usage.cacheRead += ev.message.usage.cache_read_input_tokens ?? 0;
            usage.cacheWrite += ev.message.usage.cache_creation_input_tokens ?? 0;
            break;
          case "content_block_start": {
            const cb = ev.content_block;
            if (cb.type === "text") {
              open.set(ev.index, { block: { type: "text", text: "" }, json: "" });
            } else if (cb.type === "thinking" || cb.type === "redacted_thinking") {
              open.set(ev.index, {
                block: { type: "reasoning", summary: "" },
                json: "",
              });
            } else if (cb.type === "tool_use") {
              open.set(ev.index, {
                block: { type: "tool_call", id: cb.id, name: cb.name, input: {} },
                json: "",
              });
              yield { type: "tool_call_start", id: cb.id, name: cb.name };
            }
            break;
          }
          case "content_block_delta": {
            const cur = open.get(ev.index);
            const d = ev.delta;
            if (!cur) break;
            if (d.type === "text_delta") {
              (cur.block as { text: string }).text += d.text;
              yield { type: "text_delta", text: d.text };
            } else if (d.type === "thinking_delta") {
              (cur.block as { summary?: string }).summary += d.thinking;
              yield { type: "reasoning_delta", text: d.thinking };
            } else if (d.type === "signature_delta") {
              cur.json += d.signature; // stashed; the SDK gives the full block at stop
            } else if (d.type === "input_json_delta") {
              cur.json += d.partial_json;
              if (cur.block.type === "tool_call") {
                yield { type: "tool_call_delta", id: cur.block.id, json: d.partial_json };
              }
            }
            break;
          }
          case "content_block_stop": {
            const cur = open.get(ev.index);
            if (!cur) break;
            open.delete(ev.index);
            if (cur.block.type === "tool_call") {
              cur.block.input = parseJson(cur.json);
            } else if (cur.block.type === "reasoning") {
              // Rebuild the signed block so it can be replayed verbatim on the next turn.
              // Without the signature Anthropic rejects the replay outright.
              cur.block.opaque = {
                provider: KIND,
                model: this.apiModel,
                payload: {
                  type: "thinking",
                  thinking: cur.block.summary ?? "",
                  signature: cur.json,
                },
              };
            }
            yield { type: "block_end", block: cur.block };
            break;
          }
          case "message_delta":
            usage.output += ev.usage.output_tokens ?? 0;
            stop = mapStop(ev.delta.stop_reason);
            break;
          case "message_stop":
            break;
          default:
            break; // ping and future event types
        }
      }
    } catch (e) {
      throw translate(e);
    }

    yield { type: "turn_end", stop, usage };
  }

  async countTokens(req: Request): Promise<number> {
    try {
      const r = await this.client.messages.countTokens({
        model: this.apiModel,
        system: this.system(req.system),
        messages: this.messages(req.turns),
        tools: req.tools.map((t) => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool.InputSchema,
        })),
      });
      return r.input_tokens;
    } catch {
      // Counting must never be the reason a run fails; fall back to an estimate.
      return estimateTokens(JSON.stringify(req.system) + JSON.stringify(req.turns));
    }
  }
}

function parseJson(s: string): unknown {
  if (s.trim() === "") return {};
  try {
    return JSON.parse(s);
  } catch {
    return { __unparsed: s };
  }
}

function mapStop(r: string | null | undefined): StopReason {
  switch (r) {
    case "tool_use":
      return "tool_call";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

export function translate(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const status = (e as { status?: number }).status;
  const msg = (e as Error)?.message ?? String(e);
  if (status === 401 || status === 403) return new ProviderError(msg, "auth", KIND, false, e);
  if (status === 429) return new ProviderError(msg, "rate_limit", KIND, true, e);
  if (status === 400 && /context|too long|max_tokens/i.test(msg))
    return new ProviderError(msg, "context_overflow", KIND, false, e);
  if (status === 400) return new ProviderError(msg, "bad_request", KIND, false, e);
  if (status && status >= 500) return new ProviderError(msg, "server", KIND, true, e);
  return new ProviderError(msg, "network", KIND, true, e);
}
