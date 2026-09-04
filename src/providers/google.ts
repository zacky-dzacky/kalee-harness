import { GoogleGenAI, type Content, type Part, type Tool } from "@google/genai";
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

const KIND = "google";

/** Gemini's effort knob is a thinking budget; -1 asks the model to decide. */
const THINKING_BUDGET: Record<Request["effort"], number> = {
  low: 0,
  medium: 4_096,
  high: 16_384,
  max: -1,
};

/**
 * The third wire format. Gemini also exposes an OpenAI-compatible endpoint, but it degrades
 * (no thought signatures, weaker tool support), so the native adapter is the default and the
 * compat path stays a fallback via a `provider: openai` registry entry.
 */
export class GoogleProvider implements ModelProvider {
  readonly kind = KIND;
  readonly id: string;
  readonly apiModel: string;
  readonly caps: Capabilities;
  readonly pricing: Pricing;
  private client: GoogleGenAI;

  constructor(entry: ModelEntry) {
    this.id = entry.id;
    this.apiModel = entry.apiModel;
    this.caps = entry.caps;
    this.pricing = entry.pricing;
    const envName = entry.apiKeyEnv ?? "GEMINI_API_KEY";
    const apiKey = process.env[envName] ?? process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new ProviderError(`${envName} is not set`, "auth", KIND, false);
    // baseURL lets the conformance suite point this adapter at a local fake server, and
    // covers Vertex-style proxies.
    this.client = new GoogleGenAI({
      apiKey,
      ...(entry.baseURL ? { httpOptions: { baseUrl: entry.baseURL } } : {}),
    });
  }

  private parts(blocks: Block[]): Part[] {
    const out: Part[] = [];
    for (const b of blocks) {
      switch (b.type) {
        case "text":
          if (b.text) out.push({ text: b.text });
          break;
        case "reasoning":
          // A thought signature must ride along with its part, replayed verbatim.
          if (b.opaque) out.push(b.opaque.payload as Part);
          break;
        case "tool_call":
          out.push({
            functionCall: { id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> },
          });
          break;
        case "tool_result":
          out.push({
            functionResponse: {
              id: b.id,
              name: b.id,
              response: {
                output: b.content
                  .filter((c): c is Extract<Block, { type: "text" }> => c.type === "text")
                  .map((c) => c.text)
                  .join("\n"),
                ...(b.isError ? { error: true } : {}),
              },
            },
          });
          break;
        default:
          assertNever(b, "Block");
      }
    }
    return out;
  }

  private contents(turns: Turn[]): Content[] {
    return filterReasoning(turns, KIND, this.apiModel)
      .map((t) => ({ role: t.role === "assistant" ? "model" : "user", parts: this.parts(t.blocks) }))
      .filter((c) => c.parts.length > 0);
  }

  private config(req: Request) {
    const tools: Tool[] = req.tools.length
      ? [
          {
            functionDeclarations: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parametersJsonSchema: t.parameters,
            })),
          },
        ]
      : [];
    return {
      systemInstruction: systemText(req.system) || undefined,
      maxOutputTokens: req.maxOutputTokens,
      temperature: req.temperature ?? 0,
      ...(req.stopSequences?.length ? { stopSequences: req.stopSequences } : {}),
      ...(tools.length ? { tools } : {}),
      ...(this.caps.reasoning === "none"
        ? {}
        : {
            thinkingConfig: {
              includeThoughts: true,
              thinkingBudget: THINKING_BUDGET[req.effort],
            },
          }),
    };
  }

  async *stream(req: Request, signal: AbortSignal): AsyncIterable<Event> {
    let stream: AsyncGenerator<{
      candidates?: Array<{ content?: Content; finishReason?: string }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        cachedContentTokenCount?: number;
        thoughtsTokenCount?: number;
      };
    }>;
    try {
      stream = await this.client.models.generateContentStream({
        model: this.apiModel,
        contents: this.contents(req.turns),
        config: { ...this.config(req), abortSignal: signal },
      });
    } catch (e) {
      throw translate(e);
    }

    const usage: Usage = emptyUsage();
    let stop: StopReason = "end_turn";
    let text = "";
    let reasoning = "";
    let calls = 0;

    try {
      for await (const chunk of stream) {
        const u = chunk.usageMetadata;
        if (u) {
          // Gemini reports cumulative counts, so assign rather than accumulate.
          usage.input = u.promptTokenCount ?? usage.input;
          usage.output = u.candidatesTokenCount ?? usage.output;
          usage.cacheRead = u.cachedContentTokenCount ?? usage.cacheRead;
          if (u.thoughtsTokenCount) usage.reasoning = u.thoughtsTokenCount;
        }
        const cand = chunk.candidates?.[0];
        if (!cand) continue;
        if (cand.finishReason) stop = mapStop(cand.finishReason);

        for (const part of cand.content?.parts ?? []) {
          const p = part as Part & { thought?: boolean; thoughtSignature?: string };
          if (p.text != null) {
            if (p.thought) {
              reasoning += p.text;
              yield { type: "reasoning_delta", text: p.text };
              if (p.thoughtSignature) {
                yield {
                  type: "block_end",
                  block: {
                    type: "reasoning",
                    summary: p.text,
                    opaque: { provider: KIND, model: this.apiModel, payload: p },
                  },
                };
                reasoning = "";
              }
            } else {
              text += p.text;
              yield { type: "text_delta", text: p.text };
            }
          }
          if (p.functionCall) {
            calls++;
            const id = p.functionCall.id ?? `call_${calls}`;
            const name = p.functionCall.name ?? "";
            const json = JSON.stringify(p.functionCall.args ?? {});
            // Gemini emits whole function calls, not deltas — synthesize the pair so core
            // sees the same event shape as a streaming backend.
            yield { type: "tool_call_start", id, name };
            yield { type: "tool_call_delta", id, json };
            yield {
              type: "block_end",
              block: { type: "tool_call", id, name, input: p.functionCall.args ?? {} },
            };
            stop = "tool_call";
          }
        }
      }
    } catch (e) {
      throw translate(e);
    }

    if (reasoning) yield { type: "block_end", block: { type: "reasoning", summary: reasoning } };
    if (text) yield { type: "block_end", block: { type: "text", text } };
    yield { type: "turn_end", stop, usage };
  }

  async countTokens(req: Request): Promise<number> {
    try {
      const r = await this.client.models.countTokens({
        model: this.apiModel,
        contents: this.contents(req.turns),
      });
      return r.totalTokens ?? 0;
    } catch {
      return estimateTokens(systemText(req.system) + JSON.stringify(req.turns));
    }
  }
}

function mapStop(r: string): StopReason {
  switch (r) {
    case "MAX_TOKENS":
      return "max_tokens";
    case "SAFETY":
    case "PROHIBITED_CONTENT":
    case "BLOCKLIST":
      return "refusal";
    case "STOP":
      return "end_turn";
    default:
      return "end_turn";
  }
}

export function translate(e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const status = (e as { status?: number }).status;
  const msg = (e as Error)?.message ?? String(e);
  if (status === 401 || status === 403 || /API key/i.test(msg))
    return new ProviderError(msg, "auth", KIND, false, e);
  if (status === 429 || /quota/i.test(msg)) return new ProviderError(msg, "rate_limit", KIND, true, e);
  if (/token count|exceeds the maximum/i.test(msg))
    return new ProviderError(msg, "context_overflow", KIND, false, e);
  if (status === 400) return new ProviderError(msg, "bad_request", KIND, false, e);
  if (status && status >= 500) return new ProviderError(msg, "server", KIND, true, e);
  return new ProviderError(msg, "network", KIND, true, e);
}
