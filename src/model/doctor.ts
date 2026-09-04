import { ProviderError, type Event, type Request } from "./ir.ts";
import type { Capabilities, ModelProvider } from "./provider.ts";
import type { ModelEntry } from "./registry.ts";
import { AnthropicProvider } from "../providers/anthropic.ts";
import { GoogleProvider } from "../providers/google.ts";
import { OpenAIProvider } from "../providers/openai.ts";

/**
 * Capability probing.
 *
 * Local capabilities vary **per model**, not per provider — two models behind the same Ollama
 * endpoint can differ on tool calling — so `kalee doctor` measures rather than trusting the
 * registry, and writes what it found back into `models.yaml`.
 */
export interface ProbeResult {
  name: string;
  ok: boolean;
  detail: string;
  /** What this probe learned, to be merged into the registry entry. */
  caps?: Partial<Capabilities>;
}

const PROBE_TOOL = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  parameters: {
    type: "object",
    properties: { city: { type: "string", description: "City name" } },
    required: ["city"],
    additionalProperties: false,
  },
};

/** The raw adapter, deliberately *not* shim-wrapped — the probe must see the truth. */
function rawProvider(entry: ModelEntry): ModelProvider {
  switch (entry.provider) {
    case "anthropic":
      return new AnthropicProvider(entry);
    case "openai":
      return new OpenAIProvider(entry);
    case "google":
      return new GoogleProvider(entry);
    default:
      throw new ProviderError(`unknown provider ${entry.provider}`, "unsupported", "doctor", false);
  }
}

export async function probe(
  entry: ModelEntry,
  onProgress?: (name: string) => void,
): Promise<ProbeResult[]> {
  const provider = rawProvider(entry);
  const results: ProbeResult[] = [];

  for (const p of [probeStreaming, probeToolCalls, probeParallelToolCalls]) {
    const r = await p(provider);
    onProgress?.(r.name);
    results.push(r);
    // Tool calling is a precondition for the parallel probe; a failure there makes the rest
    // meaningless rather than merely unknown.
    if (r.name === "tool calls" && !r.ok) break;
  }

  return results;
}

async function collect(provider: ModelProvider, req: Request, ms = 90_000): Promise<Event[]> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const out: Event[] = [];
    for await (const ev of provider.stream(req, ctl.signal)) out.push(ev);
    return out;
  } finally {
    clearTimeout(t);
  }
}

const base = (overrides: Partial<Request> = {}): Request => ({
  system: [{ text: "You are a terse assistant.", cache: true }],
  turns: [{ role: "user", blocks: [{ type: "text", text: "Say the word: ready" }] }],
  tools: [],
  effort: "low",
  maxOutputTokens: 256,
  ...overrides,
});

async function probeStreaming(provider: ModelProvider): Promise<ProbeResult> {
  try {
    const events = await collect(provider, base());
    const deltas = events.filter((e) => e.type === "text_delta").length;
    const end = events.find((e) => e.type === "turn_end");
    if (!end) return { name: "streaming", ok: false, detail: "no turn_end event" };
    return {
      name: "streaming",
      ok: deltas > 0,
      detail: deltas > 0
        ? `${deltas} text deltas, ${end.usage.input} in / ${end.usage.output} out`
        : "responded but emitted no text deltas",
    };
  } catch (e) {
    return { name: "streaming", ok: false, detail: describe(e) };
  }
}

async function probeToolCalls(provider: ModelProvider): Promise<ProbeResult> {
  try {
    const events = await collect(
      provider,
      base({
        tools: [PROBE_TOOL],
        turns: [
          {
            role: "user",
            blocks: [{ type: "text", text: "What is the weather in Paris? Use the tool." }],
          },
        ],
      }),
    );
    const calls = events.filter((e) => e.type === "tool_call_start");
    const ok = calls.length > 0;
    return {
      name: "tool calls",
      ok,
      detail: ok
        ? `emitted ${calls.length} structured call(s)`
        : "no structured tool call — the shim will be used",
      caps: { nativeToolCalls: ok },
    };
  } catch (e) {
    // A 400 here usually means the backend rejects a `tools` array outright.
    return {
      name: "tool calls",
      ok: false,
      detail: describe(e),
      caps: { nativeToolCalls: false },
    };
  }
}

async function probeParallelToolCalls(provider: ModelProvider): Promise<ProbeResult> {
  try {
    const events = await collect(
      provider,
      base({
        tools: [PROBE_TOOL],
        turns: [
          {
            role: "user",
            blocks: [
              {
                type: "text",
                text: "Get the weather for Paris and for Tokyo. Call the tool for both in one turn.",
              },
            ],
          },
        ],
      }),
    );
    const calls = events.filter((e) => e.type === "tool_call_start").length;
    return {
      name: "parallel tool calls",
      ok: calls > 1,
      detail: `${calls} call(s) in one turn`,
      caps: { parallelToolCalls: calls > 1 },
    };
  } catch (e) {
    return { name: "parallel tool calls", ok: false, detail: describe(e), caps: { parallelToolCalls: false } };
  }
}

/** Everything the probes learned, ready to merge into `models.yaml`. */
export function mergedCaps(results: ProbeResult[]): Partial<Capabilities> {
  return Object.assign({}, ...results.map((r) => r.caps ?? {}));
}

function describe(e: unknown): string {
  if (e instanceof ProviderError) return `${e.kind}: ${e.message}`;
  return (e as Error)?.message ?? String(e);
}
