import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { addUsage, emptyUsage, type StopReason, type Usage } from "../model/ir.ts";
import { costOf, type Pricing } from "../model/provider.ts";
import type { Effect } from "../tools/types.ts";

/**
 * Observability *and* the audit trail — one writer, two consumers (LAYERS.md: Observability,
 * Governance). Everything that happened is a JSONL record at `.kalee/traces/<id>.jsonl`.
 */
export type TraceEvent =
  | { t: "run_start"; at: string; command: string; cwd: string }
  | { t: "turn_start"; at: string; pass: string; model: string; turn: number }
  | {
      t: "turn_end";
      at: string;
      pass: string;
      model: string;
      turn: number;
      stop: StopReason;
      usage: Usage;
      costUsd: number;
      durationMs: number;
    }
  | {
      t: "tool_call";
      at: string;
      pass: string;
      tool: string;
      effect: Effect;
      allowed: boolean;
      reason?: string;
      durationMs: number;
      isError: boolean;
      input: unknown;
    }
  | { t: "finding"; at: string; pass: string; finding: unknown }
  | { t: "note"; at: string; pass: string; message: string; data?: unknown }
  | { t: "error"; at: string; pass: string; kind: string; message: string }
  | { t: "run_end"; at: string; usage: Usage; costUsd: number; durationMs: number };

export class Trace {
  readonly id: string;
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();
  private total: Usage = emptyUsage();
  private cost = 0;
  private started = Date.now();
  private events: TraceEvent[] = [];

  constructor(id: string, root: string) {
    this.id = id;
    this.path = join(root, ".kalee", "traces", `${id}.jsonl`);
  }

  /** Append-only, serialized: concurrent tool calls must not interleave a half-written line. */
  write(ev: TraceEvent): void {
    this.events.push(ev);
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, JSON.stringify(ev) + "\n", "utf8");
    });
  }

  note(pass: string, message: string, data?: unknown): void {
    this.write({ t: "note", at: now(), pass, message, data });
  }

  error(pass: string, kind: string, message: string): void {
    this.write({ t: "error", at: now(), pass, kind, message });
  }

  turnEnd(args: {
    pass: string;
    model: string;
    turn: number;
    stop: StopReason;
    usage: Usage;
    pricing: Pricing;
    durationMs: number;
  }): void {
    const costUsd = costOf(args.pricing, args.usage);
    this.total = addUsage(this.total, args.usage);
    this.cost += costUsd;
    this.write({
      t: "turn_end",
      at: now(),
      pass: args.pass,
      model: args.model,
      turn: args.turn,
      stop: args.stop,
      usage: args.usage,
      costUsd,
      durationMs: args.durationMs,
    });
  }

  usage(): Usage {
    return this.total;
  }

  costUsd(): number {
    return this.cost;
  }

  all(): readonly TraceEvent[] {
    return this.events;
  }

  async finish(): Promise<void> {
    this.write({
      t: "run_end",
      at: now(),
      usage: this.total,
      costUsd: this.cost,
      durationMs: Date.now() - this.started,
    });
    await this.flush();
  }

  /** Await every queued append. Callers must do this before exiting. */
  flush(): Promise<void> {
    return this.queue;
  }
}

export const now = () => new Date().toISOString();

export function newId(): string {
  const d = new Date();
  // 14, not 15: the 15th character of a stripped ISO timestamp is the fractional-seconds
  // dot, and `Session.fork` uses a dot to mark a sub-agent session (`<id>.<pass>`).
  const stamp = d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A trace that writes nowhere — for tests and eval fixtures. */
export function nullTrace(): Trace {
  const t = new Trace("null", "/dev/null");
  t.write = () => {};
  return t;
}
