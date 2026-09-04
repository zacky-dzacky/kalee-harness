import { z } from "zod";
import { exec } from "./exec.ts";
import { jailed } from "./paths.ts";
import { fail, ok, type Tool, type ToolCtx } from "./types.ts";

/**
 * Git is review's core signal, so it gets dedicated tools rather than bash: the harness caps
 * and renders the output, and a cached diff is not re-shelled on every question.
 */

const MAX_DIFF_BYTES = 200 * 1024;

async function git(argv: string[], ctx: ToolCtx) {
  return exec(["git", ...argv], {
    cwd: ctx.cwd,
    timeoutMs: 20_000,
    maxBytes: MAX_DIFF_BYTES,
    signal: ctx.signal,
  });
}

const diffSchema = z.object({
  base: z.string().optional().describe("Base ref. Omit to diff the working tree against HEAD."),
  head: z.string().optional().describe("Head ref. Defaults to the working tree."),
  path: z.string().optional().describe("Restrict the diff to this path."),
  staged: z.boolean().optional(),
});

export const gitDiffTool: Tool = {
  name: "git_diff",
  description:
    "Show a unified diff. Without arguments, diffs the working tree against HEAD. Use `base` to compare against a branch.",
  schema: diffSchema,
  effect: "read-only",
  parallelSafe: true,
  async call(input: unknown, ctx: ToolCtx) {
    const { base, head, path, staged } = diffSchema.parse(input);
    const argv = ["diff", "--no-color", "--find-renames"];
    if (staged) argv.push("--cached");
    if (base && head) argv.push(`${base}...${head}`);
    else if (base) argv.push(base);
    if (path) {
      try {
        jailed(ctx.cwd, path);
      } catch (e) {
        return fail((e as Error).message);
      }
      argv.push("--", path);
    }
    const r = await git(argv, ctx);
    if (r.code !== 0) return fail(r.stderr.trim() || "git diff failed");
    if (!r.stdout.trim()) return ok("(no changes)");
    return ok(r.stdout + (r.truncated ? "\n… diff truncated at the output cap" : ""));
  },
};

const showSchema = z.object({
  ref: z.string().describe("Commit-ish, or `ref:path` to show a file at that revision."),
});

export const gitShowTool: Tool = {
  name: "git_show",
  description:
    "Show a commit, or a file's contents at a revision with `ref:path` (e.g. 'main:src/index.ts').",
  schema: showSchema,
  effect: "read-only",
  parallelSafe: true,
  async call(input: unknown, ctx: ToolCtx) {
    const { ref } = showSchema.parse(input);
    const r = await git(["show", "--no-color", ref], ctx);
    if (r.code !== 0) return fail(r.stderr.trim() || `git show ${ref} failed`);
    return ok(r.stdout + (r.truncated ? "\n… truncated at the output cap" : ""));
  },
};

const blameSchema = z.object({
  path: z.string(),
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
});

export const gitBlameTool: Tool = {
  name: "git_blame",
  description:
    "Show the commit, author and date that last touched each line — use it to tell new code from code the diff merely moved.",
  schema: blameSchema,
  effect: "read-only",
  parallelSafe: true,
  async call(input: unknown, ctx: ToolCtx) {
    const { path, startLine, endLine } = blameSchema.parse(input);
    try {
      jailed(ctx.cwd, path);
    } catch (e) {
      return fail((e as Error).message);
    }
    // Plain (non-porcelain) blame: one readable line per source line, which is what the model
    // can actually use.
    const argv = ["blame", "--date=short"];
    if (startLine) argv.push("-L", `${startLine},${endLine ?? startLine + 40}`);
    argv.push("--", path);
    const r = await git(argv, ctx);
    if (r.code !== 0) return fail(r.stderr.trim() || "git blame failed");
    return ok(r.stdout);
  },
};

export const gitTools = [gitDiffTool, gitShowTool, gitBlameTool];
