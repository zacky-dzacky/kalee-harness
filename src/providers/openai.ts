import OpenAI from "openai";
import {
  assertNever,
  emptyUsage,
  filterReasoning,
  ProviderError,
  systemText,
  type Block,
  type Event,
  type Request,
  type StopReason,
  type Turn,
  type Usage,
} from "../model/ir.ts";
import { estimateTokens, type Capabilities, type ModelProvider, type Pricing } from "../model/provider.ts";
import type { ModelEntry } from "../model/registry.ts";

const KIND = "openai";

/**
 * The Chat Completions wire format, which is the lingua franca: OpenAI, Ollama, MLX,
 * LM Studio, vLLM, llama.cpp, OpenRouter, Groq, Together, DeepSeek, Mistral, xAI.
 *
 * Caching is automatic (prefix-based) on the hosted API and absent locally, so `CacheSpan`
 * breakpoints are a no-op here — the spans still order the prompt correctly, which is the
 * part that actually matters for the hosted cache to hit.
 */
export class OpenAIProvider implements ModelProvider {
  readonly kind = KIND;
  readonly id: string;
  readonly apiModel: string;
  readonly caps: Capabilities;
  readonly pricing: Pricing;
  private client: OpenAI;

  constructor(entry: ModelEntry) {
    this.id = entry.id;
    this.apiModel = entry.apiModel;
    this.caps = entry.caps;
    this.pricing = entry.pricing;
    const envName = entry.apiKeyEnv ?? "OPENAI_API_KEY";
    // Local backends ignore the key but the SDK insists on one.
    const apiKey = process.env[envName] ?? (entry.baseURL ? "local" : undefined);
    if (!apiKey) throw new ProviderError(`${envName} is not set`, "auth", KIND, false);
    this.client = new OpenAI({ apiKey, baseURL: entry.baseURL });
  }

  private messages(req: Request): OpenAI.Chat.ChatCompletionMessageParam[] {
    // No top-level system field here: it becomes the first message.
    const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    const sys = systemText(req.system);
    if (sys.trim()) out.push({ role: "system", content: sys });

    for (const turn of filterReasoning(req.turns, KIND, this.apiModel)) {
      out.push(...this.turn(turn));
    }
    return out;
  }

  private turn(turn: Turn): OpenAI.Chat.ChatCompletionMessageParam[] {
    const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
    let text = "";
    const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = [];
    // Tool results are their own `role: "tool"` messages and must follow the assistant
    // message that requested them.
    const results: OpenAI.Chat.ChatCompletionToolMessageParam[] = [];

    for (const b of turn.blocks) {
      switch (b.type) {
        case "text":
          text += b.text;
          break;
        case "reasoning":
          break; // encrypted reasoning items are not replayable on chat completions
        case "tool_call":
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
          break;
        case "tool_result":
          results.push({
            role: "tool",
            tool_call_id: b.id,
            content: b.content
              .filter((c): c is Extract<Block, { type: "text" }> => c.type === "text")
              .map((c) => c.text)
              .join("\n"),
          });
          break;
        default:
          assertNever(b, "Block");
      }
    }

    if (turn.role === "assistant") {
      if (text || toolCalls.length) {
        out.push({
          role: "assistant",
          content: text || null,
          ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
        });
      }
    } else if (text) {
      out.push({ role: "user", content: text });
    }
    out.push(...results);
    return out;
  }

  private body(req: Request): OpenAI.Chat.ChatCompletionCreateParamsStreaming {
    const body: OpenAI.Chat.ChatCompletionCreateParamsStreaming = {
      model: this.apiModel,
      messages: this.messages(req),
      max_completion_tokens: req.maxOutputTokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    // Reasoning models reject a temperature; non-reasoning ones want a deterministic 0.
    if (this.caps.reasoning === "none") body.temperature = req.temperature ?? 0;
    if (this.caps.reasoning === "effort") {
      // The IR's `max` has no wire equivalent; it maps to the highest native setting.
      body.reasoning_effort = (req.effort === "max" ? "high" : req.effort) as "low" | "medium" | "high";
    }
    if (req.tools.length && this.caps.nativeToolCalls) {
      body.tools = req.tools.map((t) => ({
        type: "function" as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          ...(this.caps.strictToolSchemas ? { strict: true } : {}),
        },
      }));
      if (this.caps.parallelToolCalls) body.parallel_tool_calls = true;
    }
    if (req.stopSequences?.length) body.stop = req.stopSequences;
    return body;
  }

  async *stream(req: Request, signal: AbortSignal): AsyncIterable<Event> {
    let stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(this.body(req), { signal });
    } catch (e) {
      throw translate(e);
    }

    const usage: Usage = emptyUsage();
    let stop: StopReason = "end_turn";
    let text = "";
    let reasoning = "";
    /** Tool calls arrive indexed, with the name in the first delta and args streamed after. */
    const calls = new Map<number, { id: string; name: string; args: string; started: boolean }>();

    try {
      for await (const chunk of stream) {
        if (chunk.usage) {
          usage.input += chunk.usage.prompt_tokens ?? 0;
          usage.output += chunk.usage.completion_tokens ?? 0;
          usage.cacheRead += chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          const r = chunk.usage.completion_tokens_details?.reasoning_tokens;
          if (r) usage.reasoning = (usage.reasoning ?? 0) + r;
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        const d = choice.delta as OpenAI.Chat.ChatCompletionChunk.Choice.Delta & {
          reasoning_content?: string; // Ollama/DeepSeek-style reasoning
          reasoning?: string; // OpenRouter-style
        };

        const think = d.reasoning_content ?? d.reasoning;
        if (think) {
          reasoning += think;
          yield { type: "reasoning_delta", text: think };
        }
        if (typeof d.content === "string" && d.content.length) {
          text += d.content;
          yield { type: "text_delta", text: d.content };
        }
        for (const tc of d.tool_calls ?? []) {
          const idx = tc.index;
          let cur = calls.get(idx);
          if (!cur) {
            // The name starts empty and is only ever appended to: some backends stream the
            // name in pieces, and seeding it here as well would double the first chunk.
            cur = { id: tc.id ?? `call_${idx}`, name: "", args: "", started: false };
            calls.set(idx, cur);
          }
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (!cur.started && cur.name) {
            cur.started = true;
            yield { type: "tool_call_start", id: cur.id, name: cur.name };
          }
          const arg = tc.function?.arguments;
          if (arg) {
            cur.args += arg;
            if (cur.started) yield { type: "tool_call_delta", id: cur.id, json: arg };
          }
        }
        if (choice.finish_reason) stop = mapStop(choice.finish_reason);
      }
    } catch (e) {
      throw translate(e);
    }

    if (reasoning) yield { type: "block_end", block: { type: "reasoning", summary: reasoning } };
    if (text) yield { type: "block_end", block: { type: "text", text } };
    for (const c of [...calls.values()]) {
      // Some backends set finish_reason "stop" even when they emitted tool calls.
      stop = "tool_call";
      yield {
        type: "block_end",
        block: { type: "tool_call", id: c.id, name: c.name, input: parseJson(c.args) },
      };
    }

    yield { type: "turn_end", stop, usage };
  }

  async countTokens(req: Request): Promise<number> {
    // Chat Completions exposes no counting endpoint, and a bundled tokenizer would be wrong
    // for every backend but one.
    return estimateTokens(
      systemText(req.system) + JSON.stringify(req.turns) + JSON.stringify(req.tools),
    );
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

function mapStop(r: string): StopReason {
  switch (r) {
    case "tool_calls":
    case "function_call":
      return "tool_call";
    case "length":
      return "max_tokens";
    case "content_filter":
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
  if (/context length|too many tokens|maximum context/i.test(msg))
    return new ProviderError(msg, "context_overflow", KIND, false, e);
  if (status === 404) return new ProviderError(msg, "unsupported", KIND, false, e);
  if (status === 400) return new ProviderError(msg, "bad_request", KIND, false, e);
  if (status && status >= 500) return new ProviderError(msg, "server", KIND, true, e);
  return new ProviderError(msg, "network", KIND, true, e);
}
