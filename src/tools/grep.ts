import { z } from "zod";
import { jailed, display } from "./paths.ts";
import { exec } from "./exec.ts";
import { fail, ok, type Tool, type ToolCtx } from "./types.ts";

const schema = z.object({
  pattern: z.string().describe("Regular expression to search for."),
  path: z.string().optional().describe("File or directory to search. Defaults to the repository root."),
  glob: z.string().optional().describe("Restrict to files matching this glob, e.g. '*.ts'."),
  ignoreCase: z.boolean().optional(),
  maxMatches: z.number().int().min(1).max(500).optional(),
});

const DEFAULT_MAX = 100;
const IGNORED = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|target)(\/|$)/;

/**
 * Shells to `rg` when present (fast, respects .gitignore) and falls back to a JS scanner so
 * the tool still works on a machine without ripgrep. Both paths return the same shape.
 */
export const grepTool: Tool = {
  name: "grep",
  description:
    "Search file contents by regex. Returns `path:line: text` matches. Prefer this over reading whole files.",
  schema,
  effect: "read-only",
  parallelSafe: true,
  async call(input: unknown, ctx: ToolCtx) {
    const args = schema.parse(input);
    const max = args.maxMatches ?? DEFAULT_MAX;
    let root: string;
    try {
      root = jailed(ctx.cwd, args.path ?? ".");
    } catch (e) {
      return fail((e as Error).message);
    }
    try {
      new RegExp(args.pattern);
    } catch (e) {
      return fail(`invalid regex: ${(e as Error).message}`);
    }

    const hits = (await hasRg())
      ? await viaRipgrep(args, root, max, ctx)
      : await viaScanner(args, root, max, ctx);

    if (hits.length === 0) return ok(`no matches for /${args.pattern}/`);
    const capped = hits.length > max;
    return ok(hits.slice(0, max).join("\n") + (capped ? `\n… truncated at ${max} matches` : ""));
  },
};

let rgAvailable: boolean | null = null;
async function hasRg(): Promise<boolean> {
  if (rgAvailable !== null) return rgAvailable;
  const r = await exec(["/bin/sh", "-c", "command -v rg"], { cwd: process.cwd(), timeoutMs: 3_000 });
  rgAvailable = r.code === 0 && r.stdout.trim().length > 0;
  return rgAvailable;
}

async function viaRipgrep(
  args: z.infer<typeof schema>,
  root: string,
  max: number,
  ctx: ToolCtx,
): Promise<string[]> {
  const argv = ["rg", "--line-number", "--no-heading", "--color=never", "--max-columns", "300"];
  if (args.ignoreCase) argv.push("-i");
  if (args.glob) argv.push("--glob", args.glob);
  argv.push("--regexp", args.pattern, root);
  const r = await exec(argv, { cwd: ctx.cwd, timeoutMs: 20_000, signal: ctx.signal });
  if (r.code > 1) return []; // exit 1 means no matches; anything higher is a real failure
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .slice(0, max + 1)
    .map((l) => relativize(l, ctx.cwd));
}

function relativize(line: string, cwd: string): string {
  const i = line.indexOf(":");
  if (i === -1) return line;
  return display(cwd, line.slice(0, i)) + line.slice(i);
}

async function viaScanner(
  args: z.infer<typeof schema>,
  root: string,
  max: number,
  ctx: ToolCtx,
): Promise<string[]> {
  const re = new RegExp(args.pattern, args.ignoreCase ? "i" : "");
  const out: string[] = [];
  const glob = new Bun.Glob(args.glob ?? "**/*");
  for await (const rel of glob.scan({ cwd: root, dot: false, onlyFiles: true })) {
    if (IGNORED.test(rel)) continue;
    if (out.length > max) break;
    const file = Bun.file(`${root}/${rel}`);
    if (file.size > 1024 * 1024) continue;
    let text: string;
    try {
      text = await file.text();
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (re.test(l)) {
        out.push(`${display(ctx.cwd, `${root}/${rel}`)}:${i + 1}: ${l.slice(0, 300)}`);
        if (out.length > max) break;
      }
    }
  }
  return out;
}
