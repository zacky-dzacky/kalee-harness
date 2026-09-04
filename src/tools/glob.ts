import { z } from "zod";
import { jailed, display } from "./paths.ts";
import { fail, ok, type Tool, type ToolCtx } from "./types.ts";

const schema = z.object({
  pattern: z.string().describe("Glob pattern, e.g. 'src/**/*.ts'."),
  path: z.string().optional().describe("Directory to search from. Defaults to the repository root."),
  limit: z.number().int().min(1).max(1000).optional(),
});

const DEFAULT_LIMIT = 200;
const IGNORED = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|target|\.kalee)(\/|$)/;

export const globTool: Tool = {
  name: "glob",
  description: "List files matching a glob pattern, sorted by most recently modified first.",
  schema,
  effect: "read-only",
  parallelSafe: true,
  async call(input: unknown, ctx: ToolCtx) {
    const { pattern, path, limit = DEFAULT_LIMIT } = schema.parse(input);
    let root: string;
    try {
      root = jailed(ctx.cwd, path ?? ".");
    } catch (e) {
      return fail((e as Error).message);
    }

    const glob = new Bun.Glob(pattern);
    const found: { path: string; mtime: number }[] = [];
    for await (const rel of glob.scan({ cwd: root, dot: false, onlyFiles: true })) {
      if (IGNORED.test(rel)) continue;
      const abs = `${root}/${rel}`;
      found.push({ path: display(ctx.cwd, abs), mtime: Bun.file(abs).lastModified });
      if (found.length >= limit * 4) break; // bound the scan, not just the output
    }
    if (found.length === 0) return ok(`no files match ${pattern}`);

    found.sort((a, b) => b.mtime - a.mtime);
    const shown = found.slice(0, limit);
    const more = found.length > limit ? `\n… ${found.length - limit} more` : "";
    return ok(shown.map((f) => f.path).join("\n") + more);
  },
};
