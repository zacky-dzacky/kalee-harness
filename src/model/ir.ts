/**
 * The canonical intermediate representation — the contract between core and providers.
 *
 * LAYERS.md: this file is the seam that keeps "Runtime" model-agnostic. Nothing above the
 * provider boundary may import a provider SDK type; everything below must translate to and
 * from these shapes.
 *
 * Discipline (see PLAN.md "Language rationale"): every `switch` over `Block` or `Event` ends
 * in `assertNever`. Adding a variant then fails compilation in every adapter rather than
 * silently no-oping in one.
 */

/** Compile-time exhaustiveness guard. A missed union variant becomes a type error. */
export function assertNever(x: never, context = "value"): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(x)}`);
}

/**
 * Provider-native reasoning state (Anthropic signed thinking blocks, OpenAI encrypted
 * reasoning items, Gemini thought signatures), carried opaquely.
 *
 * Replayed **only** when the same provider *and* model produced it. Replaying it elsewhere
 * is a hard API error; dropping it when it should be replayed is an invisible quality loss.
 */
export interface OpaqueReasoning {
  provider: string;
  model: string;
  payload: unknown;
}

export type Block =
  | { type: "text"; text: string }
  | { type: "reasoning"; summary?: string; opaque?: OpaqueReasoning }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: Block[]; isError: boolean };

export type Role = "user" | "assistant";

export interface Turn {
  role: Role;
  blocks: Block[];
}

export type StopReason =
  | "end_turn"
  | "tool_call"
  | "max_tokens"
  | "stop_sequence"
  | "refusal"
  | "error";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
}

export const emptyUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) || undefined,
  };
}

export type Event =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; json: string }
  | { type: "block_end"; block: Block }
  | { type: "turn_end"; stop: StopReason; usage: Usage };

/**
 * A stable prefix of the system prompt. Core declares "cache from here"; the adapter decides
 * how — Anthropic inserts `cache_control`, OpenAI no-ops (automatic prefix caching), Gemini
 * creates or reuses a cached-content handle, local models ignore it entirely.
 *
 * Everything volatile (timestamps, the diff, the question) must sit *after* the last span
 * marked `cache: true`, or caching silently never hits.
 */
export interface CacheSpan {
  text: string;
  /** Mark a cache breakpoint at the end of this span. */
  cache?: boolean;
}

export type Effort = "low" | "medium" | "high" | "max";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "max"] as const;

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset understood by every provider). */
  parameters: Record<string, unknown>;
}

export interface Request {
  /** Core marks stable prefixes; the adapter decides how to cache them. */
  system: CacheSpan[];
  turns: Turn[];
  tools: ToolDef[];
  /** low..max — the adapter maps this to a native knob or ignores it. */
  effort: Effort;
  maxOutputTokens: number;
  /** Optional decoding controls; adapters ignore what they cannot express. */
  temperature?: number;
  stopSequences?: string[];
}

/**
 * Typed provider failure. Adapters surface errors as this rather than throwing raw SDK
 * objects, so the loop can decide to retry, degrade, or abort without provider knowledge.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "auth"
      | "rate_limit"
      | "context_overflow"
      | "bad_request"
      | "server"
      | "network"
      | "unsupported",
    readonly provider: string,
    readonly retryable: boolean,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

// ---------------------------------------------------------------------------
// Small helpers over the IR. Kept here so adapters and core share one implementation.
// ---------------------------------------------------------------------------

export function textOf(blocks: Block[]): string {
  let out = "";
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        out += b.text;
        break;
      case "reasoning":
      case "tool_call":
      case "tool_result":
        break;
      default:
        assertNever(b, "Block");
    }
  }
  return out;
}

export function toolCallsOf(blocks: Block[]): Extract<Block, { type: "tool_call" }>[] {
  return blocks.filter((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call");
}

/** Flatten system spans for providers that take a single system string. */
export function systemText(spans: CacheSpan[]): string {
  return spans.map((s) => s.text).join("\n\n");
}

/**
 * Drop reasoning blocks that a different provider/model produced. Every adapter calls this
 * on the way in; keeping it here means the rule is stated once.
 */
export function filterReasoning(turns: Turn[], provider: string, model: string): Turn[] {
  return turns.map((t) => ({
    role: t.role,
    blocks: t.blocks.filter((b) => {
      if (b.type !== "reasoning") return true;
      if (!b.opaque) return false; // summary-only reasoning is never replayable
      return b.opaque.provider === provider && b.opaque.model === model;
    }),
  }));
}
