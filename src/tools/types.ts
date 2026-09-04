import type { z } from "zod";
import type { Policy } from "../core/policy.ts";
import type { Trace } from "../core/trace.ts";

/**
 * `effect` is the seam that makes Governance real: policy gates on it, trace records it, and
 * the loop uses `parallelSafe` to decide fan-out.
 */
export type Effect = "read-only" | "mutating" | "external";

export interface ToolOutput {
  content: string;
  isError?: boolean;
  /** Structured payload for tools the harness consumes itself (e.g. report_finding). */
  data?: unknown;
}

export interface ToolCtx {
  /** The path jail. Every resolved path must stay inside it. */
  cwd: string;
  policy: Policy;
  trace: Trace;
  signal: AbortSignal;
  /** Sink for tools that hand structured results back to the pipeline. */
  emit?(kind: string, value: unknown): void;
}

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  effect: Effect;
  parallelSafe: boolean;
  call(input: unknown, ctx: ToolCtx): Promise<ToolOutput>;
}

export const ok = (content: string, data?: unknown): ToolOutput => ({ content, data });
export const fail = (content: string): ToolOutput => ({ content, isError: true });
