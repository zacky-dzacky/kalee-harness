import type { Event, Request } from "./ir.ts";

/**
 * What a backend can actually do. Declared in `models.yaml`, but for local backends it is
 * *probed* by `kalee doctor` — two models behind the same Ollama endpoint can differ on
 * tool calling, so provider-level assumptions are wrong.
 *
 * The loop reads these to degrade instead of crashing.
 */
export interface Capabilities {
  /** false -> route through providers/shim.ts (text tool-call protocol). */
  nativeToolCalls: boolean;
  /** false -> the loop serializes tool dispatch. */
  parallelToolCalls: boolean;
  reasoning: "none" | "effort" | "budget" | "always-on";
  explicitCacheBreakpoints: boolean;
  /** false -> wrap tool input validation in validate-and-retry. */
  strictToolSchemas: boolean;
  maxContext: number;
  vision: boolean;
}

export const DEFAULT_CAPS: Capabilities = {
  nativeToolCalls: true,
  parallelToolCalls: false,
  reasoning: "none",
  explicitCacheBreakpoints: false,
  strictToolSchemas: false,
  maxContext: 32768,
  vision: false,
};

/** Dollars per million tokens. */
export interface Pricing {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export const FREE: Pricing = { input: 0, output: 0 };

export interface ModelProvider {
  /** Registry id (e.g. `opus-5`), not the wire model name. */
  readonly id: string;
  /** Adapter family: `anthropic` | `openai` | `google` (`+shim` when wrapped). */
  readonly kind: string;
  /** Provider-native model name, used to scope reasoning replay. */
  readonly apiModel: string;
  readonly caps: Capabilities;
  readonly pricing: Pricing;
  stream(req: Request, signal: AbortSignal): AsyncIterable<Event>;
  countTokens(req: Request): Promise<number>;
}

/** Cost in dollars for a usage record, from registry pricing. */
export function costOf(
  pricing: Pricing,
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const M = 1_000_000;
  return (
    (usage.input * pricing.input) / M +
    (usage.output * pricing.output) / M +
    (usage.cacheRead * (pricing.cacheRead ?? pricing.input)) / M +
    (usage.cacheWrite * (pricing.cacheWrite ?? pricing.input)) / M
  );
}

/**
 * Adapter fallback when a backend offers no token counting endpoint. Deliberately crude:
 * a bundled tokenizer would be exactly wrong for every model but the one it was built for.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.6);
}
