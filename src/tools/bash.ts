import { z } from "zod";
import { denied, shell, DEFAULT_TIMEOUT_MS } from "./exec.ts";
import { fail, ok, type Tool, type ToolCtx } from "./types.ts";

const schema = z.object({
  command: z.string().describe("Shell command to run, from the repository root."),
  timeoutMs: z.number().int().min(100).max(120_000).optional(),
});

/**
 * The breadth escape hatch. Gated by policy because its `effect` is `external`: unlike the
 * other v1 builtins, the harness cannot tell what a shell command will do.
 *
 * Principle: start with bash for breadth; promote an action to a dedicated tool once you need
 * to gate, render, audit, or parallelize it.
 */
export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the repository root. Prefer read_file, grep, glob and the git tools when they fit — they are cheaper and always permitted.",
  schema,
  effect: "external",
  parallelSafe: false,
  async call(input: unknown, ctx: ToolCtx) {
    const { command, timeoutMs = DEFAULT_TIMEOUT_MS } = schema.parse(input);
    const reason = denied(command);
    if (reason) return fail(`refused: ${reason}`);

    const r = await shell(command, { cwd: ctx.cwd, timeoutMs, signal: ctx.signal });
    const parts: string[] = [];
    if (r.stdout.trim()) parts.push(r.stdout.trimEnd());
    if (r.stderr.trim()) parts.push(`[stderr]\n${r.stderr.trimEnd()}`);
    if (r.timedOut) parts.push(`[timed out after ${timeoutMs}ms; process group killed]`);
    if (r.truncated) parts.push("[output truncated at the byte cap]");
    const body = parts.join("\n") || "(no output)";
    return r.code === 0 && !r.timedOut ? ok(body) : fail(`exit ${r.code}\n${body}`);
  },
};
