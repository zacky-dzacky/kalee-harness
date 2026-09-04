import type { ModelProvider } from "../model/provider.ts";
import type { CacheSpan, Request } from "../model/ir.ts";
import type { FileChange } from "../review/target.ts";

/**
 * Caching & compression (LAYERS.md: Adaptation).
 *
 * `caps.maxContext` becomes load-bearing the moment local models are in play: a 60k-token diff
 * cannot go to a 32k model. Rather than failing, the scan pass degrades to per-file
 * map-reduce — which is a natural decomposition for review anyway, and puts real work through
 * the task-pipeline layer.
 */
export interface FitPlan {
  /** One entry per pass. A single batch means everything fit in one context. */
  batches: FileChange[][];
  reason: string;
}

/** Leave room for the response, tool schemas, and the tool-result turns the loop will add. */
const RESERVE_FRACTION = 0.45;

export async function planBatches(
  provider: ModelProvider,
  system: CacheSpan[],
  files: FileChange[],
  renderPayload: (files: FileChange[]) => string,
  maxOutputTokens: number,
): Promise<FitPlan> {
  const usable = Math.floor(provider.caps.maxContext * (1 - RESERVE_FRACTION)) - maxOutputTokens;
  if (usable <= 0) throw new Error(`${provider.id}: maxContext is too small to review anything`);

  const whole = await measure(provider, system, renderPayload(files));
  if (whole <= usable) {
    return { batches: [files], reason: `${whole} tokens fits ${provider.id} (${usable} usable)` };
  }

  // Greedy per-file packing. A single file that overflows on its own still gets its own batch:
  // truncating it silently would be worse than a long pass the model can at least partly read.
  const batches: FileChange[][] = [];
  let current: FileChange[] = [];
  let currentTokens = 0;
  for (const f of files) {
    const cost = await measure(provider, system, renderPayload([f]));
    if (current.length > 0 && currentTokens + cost > usable) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(f);
    currentTokens += cost;
  }
  if (current.length) batches.push(current);

  return {
    batches,
    reason: `${whole} tokens exceeds ${usable} usable on ${provider.id}; split into ${batches.length} passes`,
  };
}

async function measure(provider: ModelProvider, system: CacheSpan[], payload: string): Promise<number> {
  const req: Request = {
    system,
    turns: [{ role: "user", blocks: [{ type: "text", text: payload }] }],
    tools: [],
    effort: "low",
    maxOutputTokens: 1,
  };
  return provider.countTokens(req);
}
