import type { ModelProvider } from "../model/provider.ts";
import { assertNever, systemText, textOf, type Block, type CacheSpan, type Request, type Turn } from "../model/ir.ts";
import { estimateTokens } from "../model/provider.ts";
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

// ---------------------------------------------------------------------------
// Conversation compaction.
//
// The batching above keeps a *diff* inside the context window. This keeps a *conversation*
// inside it, which is the same problem one layer up: an interactive session grows without
// bound, and a 32k local model runs out several exchanges before an Opus-class one does.
// ---------------------------------------------------------------------------

export interface FitEstimate {
  tokens: number;
  limit: number;
  /** Share of the model's context the conversation currently occupies. */
  fraction: number;
}

/**
 * A crude, free estimate — no round trip. Used to decide whether asking the backend for a real
 * count is worth it, since `countTokens` is a network call on every provider that offers it.
 */
export function crudeTokens(system: CacheSpan[], turns: Turn[]): number {
  return estimateTokens(systemText(system)) + estimateTokens(renderTranscript(turns));
}

export async function estimateFit(
  provider: ModelProvider,
  system: CacheSpan[],
  turns: Turn[],
): Promise<FitEstimate> {
  const limit = provider.caps.maxContext;
  let tokens: number;
  try {
    tokens = await provider.countTokens({ system, turns, tools: [], effort: "low", maxOutputTokens: 1 });
  } catch {
    // Counting is a convenience, not a correctness requirement: a backend that refuses to
    // count a transcript must not take the session down with it.
    tokens = crudeTokens(system, turns);
  }
  return { tokens, limit, fraction: limit > 0 ? tokens / limit : 0 };
}

export interface Compaction {
  /** The replacement transcript: one summary turn, then whatever was kept verbatim. */
  turns: Turn[];
  summary: string;
  /** How many turns the summary replaced. */
  dropped: number;
}

const SUMMARY_SYSTEM =
  "You compress a coding session's transcript so the conversation can continue in a fresh " +
  "context. You are writing notes to your future self, not a report for a human.";

/**
 * Replace the older part of a transcript with a summary of it.
 *
 * The summary is deliberately written *to the agent*, not about it: what was established about
 * the code is the part that must survive, and a chatty recap of who said what is exactly the
 * part that must not.
 */
export async function summarizeTranscript(
  provider: ModelProvider,
  turns: Turn[],
  opts: { keepLast?: number; signal?: AbortSignal } = {},
): Promise<Compaction> {
  const cut = safeCut(turns, opts.keepLast ?? 4);
  const older = turns.slice(0, cut);
  const kept = turns.slice(cut);
  if (older.length === 0) return { turns, summary: "", dropped: 0 };

  const prompt = `Here is the earlier part of a session between a user and a read-only code-review agent.

<transcript>
${renderTranscript(older)}
</transcript>

Write a compact briefing that lets the agent continue without this transcript. Cover, in this order and omitting any that do not apply:

1. **Goal** — what the user is actually trying to do.
2. **Established** — what was determined about the code, with file:line references. Facts, not narrative.
3. **Open** — questions asked but not answered, and anything the user asked for that is unfinished.
4. **Files** — paths already read, so they are not re-read needlessly.

Be terse. Preserve every specific identifier, path and line number; drop all pleasantries.`;

  const stream = provider.stream(
    {
      system: [{ text: SUMMARY_SYSTEM, cache: true }],
      turns: [{ role: "user", blocks: [{ type: "text", text: prompt }] }],
      tools: [],
      effort: "low",
      maxOutputTokens: 2048,
    },
    opts.signal ?? new AbortController().signal,
  );

  let summary = "";
  for await (const ev of stream) {
    if (ev.type === "text_delta") summary += ev.text;
  }
  summary = summary.trim();
  if (!summary) return { turns, summary: "", dropped: 0 };

  const head: Turn = {
    role: "user",
    blocks: [
      {
        type: "text",
        text: `[Earlier in this session — ${older.length} turns, summarized]\n\n${summary}`,
      },
    ],
  };
  return { turns: [head, ...kept], summary, dropped: older.length };
}

/**
 * Where the kept window may begin. Only a genuine user message is a safe boundary: starting at
 * a turn carrying a `tool_result` would orphan it from the `tool_call` that produced it, and
 * every provider rejects that on replay.
 */
function safeCut(turns: Turn[], keepLast: number): number {
  for (let i = Math.max(0, turns.length - keepLast); i < turns.length; i++) {
    const t = turns[i];
    if (t && t.role === "user" && t.blocks.every((b) => b.type === "text")) return i;
  }
  return turns.length; // no safe boundary — keep nothing verbatim
}

/** The transcript as plain text, for summarizing and for crude token estimates. */
export function renderTranscript(turns: Turn[]): string {
  const out: string[] = [];
  for (const t of turns) {
    const body = t.blocks.map(renderBlock).filter(Boolean).join("\n");
    if (body.trim()) out.push(`## ${t.role}\n${body}`);
  }
  return out.join("\n\n");
}

function renderBlock(b: Block): string {
  switch (b.type) {
    case "text":
      return b.text;
    case "reasoning":
      return b.summary ? `(thinking) ${b.summary}` : "";
    case "tool_call":
      return `(called ${b.name} ${JSON.stringify(b.input)})`;
    case "tool_result":
      return `(result${b.isError ? ", error" : ""}) ${textOf(b.content).slice(0, 2000)}`;
    default:
      return assertNever(b, "Block");
  }
}
