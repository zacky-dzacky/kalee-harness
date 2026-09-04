import { z } from "zod";
import { stat } from "node:fs/promises";
import { jailed, display } from "./paths.ts";
import { fail, ok, type Tool, type ToolCtx } from "./types.ts";

const schema = z.object({
  path: z.string().describe("File path, relative to the repository root."),
  offset: z.number().int().min(1).optional().describe("1-based line to start from."),
  limit: z.number().int().min(1).optional().describe("Maximum number of lines to return."),
});

const MAX_BYTES = 512 * 1024;
const DEFAULT_LIMIT = 2000;
const MAX_LINE = 2000;

/**
 * Dedicated rather than `cat` because it does four things bash cannot: line numbering the
 * model can cite as `file:line`, a byte cap, the path jail, and stable formatting that lets
 * the context layer dedupe repeated reads.
 */
export const readFileTool: Tool = {
  name: "read_file",
  description:
    "Read a text file with line numbers. Returns `<line>\\t<text>` per line. Use offset/limit for large files.",
  schema,
  effect: "read-only",
  parallelSafe: true,
  async call(input: unknown, ctx: ToolCtx) {
    const { path, offset = 1, limit = DEFAULT_LIMIT } = schema.parse(input);
    let abs: string;
    try {
      abs = jailed(ctx.cwd, path);
    } catch (e) {
      return fail((e as Error).message);
    }

    const info = await stat(abs).catch(() => null);
    if (!info) return fail(`no such file: ${path}`);
    if (info.isDirectory()) return fail(`${path} is a directory; use glob to list it`);
    if (info.size > MAX_BYTES) {
      return fail(`${path} is ${info.size} bytes, over the ${MAX_BYTES}-byte read cap`);
    }

    const raw = await Bun.file(abs).text();
    if (raw.includes("\u0000")) return fail(`${path} looks like a binary file`);

    const lines = raw.split("\n");
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    if (slice.length === 0) {
      return fail(`${path} has ${lines.length} lines; offset ${offset} is past the end`);
    }
    const body = slice
      .map((l, i) => `${offset + i}\t${l.length > MAX_LINE ? l.slice(0, MAX_LINE) + "…" : l}`)
      .join("\n");
    const end = offset - 1 + slice.length;
    const more =
      end < lines.length ? `\n… ${lines.length - end} more lines (${display(ctx.cwd, abs)})` : "";
    return ok(body + more);
  },
};
