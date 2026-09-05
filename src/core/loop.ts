import {
  assertNever,
  emptyUsage,
  ProviderError,
  type Block,
  type CacheSpan,
  type Effort,
  type Event,
  type StopReason,
  type Turn,
  type Usage,
} from "../model/ir.ts";
import { costOf, type ModelProvider } from "../model/provider.ts";
import type { ToolRegistry } from "../tools/index.ts";
import type { Effect, ToolCtx, ToolOutput } from "../tools/types.ts";
import { Budget, DEFAULT_LIMITS, type BudgetLimits } from "./budget.ts";
import type { Policy } from "./policy.ts";
import type { Session } from "./session.ts";
import { now, type Trace } from "./trace.ts";

/**
 * The agent loop (LAYERS.md: Orchestration & lifecycle).
 *
 * Written against the IR only — this file never learns which provider it is talking to, which
 * is the property that makes swapping backends a config change.
 */
export interface LoopOptions {
  provider: ModelProvider;
  tools: ToolRegistry;
  system: CacheSpan[];
  session: Session;
  trace: Trace;
  policy: Policy;
  cwd: string;
  pass: string;
  effort?: Effort;
  maxOutputTokens?: number;
  limits?: BudgetLimits;
  signal?: AbortSignal;
  /** Streamed assistant text, for the terminal renderer. */
  onText?(text: string): void;
  /** Structured values a tool handed back (e.g. findings). */
  onEmit?(kind: string, value: unknown): void;
  /**
   * Live tool-call feedback. The trace records every call too, but only *after* it returns —
   * an interactive frontend has to show the call the moment it starts, or a slow grep looks
   * like a hang.
   */
  onTool?(event: ToolEvent): void;
  /**
   * Completion condition for a sub-agent whose task is done the moment it produces its
   * structured output — the verify pass is done when it has a verdict. Without this the loop
   * can only stop when the model volunteers a turn with no tool call, which wastes turns and,
   * on a model that keeps calling, runs all the way to the turn cap.
   */
  stopWhen?(): boolean;
}

export interface ToolEvent {
  phase: "start" | "end";
  name: string;
  effect: Effect;
  input: unknown;
  /** `end` only. */
  isError?: boolean;
  durationMs?: number;
  /** `end` only: a one-line preview of what the tool returned. */
  preview?: string;
}

export interface LoopResult {
  turns: Turn[];
  text: string;
  usage: Usage;
  costUsd: number;
  stop: StopReason;
  /** Set when the loop ended for a reason other than the model finishing. */
  haltReason?: string;
}

export async function runLoop(opts: LoopOptions): Promise<LoopResult> {
  const {
    provider,
    tools,
    system,
    session,
    trace,
    policy,
    cwd,
    pass,
    effort = "medium",
    maxOutputTokens = 8192,
  } = opts;

  const budget = new Budget(opts.limits ?? DEFAULT_LIMITS);
  const total: Usage = emptyUsage();
  let cost = 0;
  let lastText = "";
  let stop: StopReason = "end_turn";
  let haltReason: string | undefined;
  let turnNo = 0;

  for (;;) {
    const gate = budget.startTurn();
    if (gate.exhausted) {
      haltReason = gate.reason;
      trace.note(pass, `budget exhausted: ${gate.reason}`);
      break;
    }
    turnNo++;

    // Each turn gets its own deadline, derived from what is left of the wall-clock budget.
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const deadline = setTimeout(() => ctl.abort(), budget.remainingMs());

    trace.write({ t: "turn_start", at: now(), pass, model: provider.id, turn: turnNo });
    const startedAt = Date.now();

    const blocks: Block[] = [];
    let usage: Usage = emptyUsage();
    let text = "";
    let interrupted = false;

    try {
      const stream = provider.stream(
        {
          system,
          turns: session.transcript(),
          tools: tools.defs(),
          effort,
          maxOutputTokens,
        },
        ctl.signal,
      );

      for await (const ev of stream) {
        switch (ev.type) {
          case "text_delta":
            text += ev.text;
            opts.onText?.(ev.text);
            break;
          case "reasoning_delta":
          case "tool_call_start":
          case "tool_call_delta":
            break; // progress signal only; the block arrives whole at block_end
          case "block_end":
            blocks.push(ev.block);
            break;
          case "turn_end":
            stop = ev.stop;
            usage = ev.usage;
            break;
          default:
            assertNever(ev, "Event");
        }
      }
    } catch (e) {
      // An abort raised by the *caller's* signal is a user action (Ctrl-C at the REPL), not a
      // provider failure. The wall-clock deadline aborts the same controller, so the caller's
      // signal — not `ctl` — is what distinguishes the two.
      if (opts.signal?.aborted) {
        interrupted = true;
      } else {
        const err = e instanceof ProviderError ? e : new ProviderError(String(e), "network", provider.kind, false, e);
        trace.error(pass, err.kind, err.message);
        throw err;
      }
    } finally {
      clearTimeout(deadline);
      opts.signal?.removeEventListener("abort", onAbort);
    }

    if (interrupted) {
      // Persist the partial *text* and nothing else. A tool_call block with no matching
      // tool_result is rejected on replay by several providers, but dropping the turn outright
      // would leave two consecutive user turns, which some of the same providers also reject.
      const partial = text.trim() ? `${text.trim()}\n\n[interrupted]` : "[interrupted]";
      session.assistant([{ type: "text", text: partial }], pass);
      lastText = text;
      haltReason = "interrupted";
      trace.note(pass, "interrupted by the caller");
      break;
    }

    const turnCost = costOf(provider.pricing, usage);
    cost += turnCost;
    accumulate(total, usage);
    budget.spend(usage, turnCost);
    trace.turnEnd({
      pass,
      model: provider.id,
      turn: turnNo,
      stop,
      usage,
      pricing: provider.pricing,
      durationMs: Date.now() - startedAt,
    });

    if (text) lastText = text;
    // An empty assistant turn would be rejected on replay by several providers.
    if (blocks.length === 0) blocks.push({ type: "text", text: text || "(no content)" });
    session.assistant(blocks, pass);

    const calls = blocks.filter((b): b is Extract<Block, { type: "tool_call" }> => b.type === "tool_call");
    if (stop !== "tool_call" || calls.length === 0) break;

    const results = await dispatch(calls, {
      provider, tools, policy, trace, cwd, pass,
      signal: ctl.signal,
      onEmit: opts.onEmit,
      onTool: opts.onTool,
    });

    // All results go back in ONE user turn. Splitting them across turns teaches the model to
    // stop calling tools in parallel, which is expensive and hard to notice.
    session.user(results, pass);

    if (opts.stopWhen?.()) {
      trace.note(pass, "task complete; ending the loop");
      break;
    }
  }

  return { turns: session.transcript(), text: lastText, usage: total, costUsd: cost, stop, haltReason };
}

interface DispatchCtx {
  provider: ModelProvider;
  tools: ToolRegistry;
  policy: Policy;
  trace: Trace;
  cwd: string;
  pass: string;
  signal: AbortSignal;
  onEmit?(kind: string, value: unknown): void;
  onTool?(event: ToolEvent): void;
}

async function dispatch(
  calls: Extract<Block, { type: "tool_call" }>[],
  ctx: DispatchCtx,
): Promise<Block[]> {
  // Fan out only when every call is parallel-safe *and* the model can handle having asked for
  // several at once. Either condition failing means serial.
  const parallel =
    ctx.provider.caps.parallelToolCalls &&
    calls.length > 1 &&
    calls.every((c) => ctx.tools.get(c.name)?.parallelSafe === true);

  if (parallel) return Promise.all(calls.map((c) => one(c, ctx)));

  const out: Block[] = [];
  for (const c of calls) out.push(await one(c, ctx));
  return out;
}

async function one(
  call: Extract<Block, { type: "tool_call" }>,
  ctx: DispatchCtx,
): Promise<Block> {
  const started = Date.now();
  const tool = ctx.tools.get(call.name);

  if (!tool) {
    // Hallucinated tool names are common on small models; naming the real ones recovers.
    const known = ctx.tools.list().map((t) => t.name).join(", ");
    return errorResult(call.id, `no such tool \`${call.name}\`. Available tools: ${known}`);
  }

  ctx.onTool?.({ phase: "start", name: tool.name, effect: tool.effect, input: call.input });

  /** Every exit from here reports the call as finished, so a frontend never leaves one open. */
  const finish = (block: Block, isError: boolean, preview: string): Block => {
    ctx.onTool?.({
      phase: "end",
      name: tool.name,
      effect: tool.effect,
      input: call.input,
      isError,
      durationMs: Date.now() - started,
      preview,
    });
    return block;
  };

  const decision = await ctx.policy.check(tool.name, tool.effect, call.input);
  if (!decision.allowed) {
    ctx.trace.write({
      t: "tool_call", at: now(), pass: ctx.pass, tool: tool.name, effect: tool.effect,
      allowed: false, reason: decision.reason, durationMs: 0, isError: true, input: call.input,
    });
    return finish(
      errorResult(call.id, `permission denied: ${decision.reason}`),
      true,
      `permission denied: ${decision.reason}`,
    );
  }

  // Validate centrally rather than trusting each tool to do it. This is also the
  // `strictToolSchemas: false` degradation: backends that cannot enforce a schema server-side
  // get the same guarantee here, and the model gets an error it can actually act on.
  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success) {
    ctx.trace.write({
      t: "tool_call", at: now(), pass: ctx.pass, tool: tool.name, effect: tool.effect,
      allowed: true, reason: "invalid arguments", durationMs: Date.now() - started,
      isError: true, input: call.input,
    });
    const message = describeToolError(parsed.error);
    return finish(errorResult(call.id, message), true, message);
  }

  let out: ToolOutput;
  try {
    const toolCtx: ToolCtx = {
      cwd: ctx.cwd,
      policy: ctx.policy,
      trace: ctx.trace,
      signal: ctx.signal,
      emit: ctx.onEmit,
    };
    out = await tool.call(parsed.data, toolCtx);
  } catch (e) {
    // A failed tool returns a result with isError, never nothing. A dropped result leaves the
    // model waiting for an answer that will never come.
    out = { content: describeToolError(e), isError: true };
  }

  ctx.trace.write({
    t: "tool_call", at: now(), pass: ctx.pass, tool: tool.name, effect: tool.effect,
    allowed: true, durationMs: Date.now() - started, isError: out.isError ?? false, input: call.input,
  });

  return finish(
    {
      type: "tool_result",
      id: call.id,
      isError: out.isError ?? false,
      content: [{ type: "text", text: out.content }],
    },
    out.isError ?? false,
    out.content,
  );
}

function errorResult(id: string, message: string): Block {
  return { type: "tool_result", id, isError: true, content: [{ type: "text", text: message }] };
}

/** Turn a zod failure into something the model can act on rather than a stack trace. */
function describeToolError(e: unknown): string {
  const err = e as { issues?: { path: (string | number)[]; message: string }[]; message?: string };
  if (Array.isArray(err.issues)) {
    const detail = err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return `invalid arguments: ${detail}`;
  }
  return err.message ?? String(e);
}

function accumulate(into: Usage, u: Usage): void {
  into.input += u.input;
  into.output += u.output;
  into.cacheRead += u.cacheRead;
  into.cacheWrite += u.cacheWrite;
  if (u.reasoning) into.reasoning = (into.reasoning ?? 0) + u.reasoning;
}
