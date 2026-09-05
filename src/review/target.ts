import { existsSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { exec, execOrThrow } from "../tools/exec.ts";

/**
 * Everything reviewable normalizes to one `ReviewTarget`, so the pipeline above never learns
 * whether it is looking at a working tree, a branch range, a path, or a GitHub PR.
 */
export type TargetSpec =
  | { kind: "working-tree" }
  | { kind: "staged" }
  | { kind: "range"; base: string; head?: string }
  | { kind: "path"; path: string }
  | { kind: "pr"; number: number; repo?: string };

export interface FileChange {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  /** Unified diff for this file. Empty in `path` mode, which has no diff signal. */
  patch: string;
  oldPath?: string;
}

export interface ReviewTarget {
  kind: TargetSpec["kind"];
  /** Human-readable description of what is under review. */
  label: string;
  files: FileChange[];
  /** True when there is no diff — the prompt differs materially. */
  wholeFile: boolean;
}

export interface TargetFlags {
  base?: string;
  staged?: boolean;
  repo?: string;
}

/**
 * The one place that turns a command line into a `TargetSpec`, shared by `kalee review` and the
 * REPL's `/review` so the two cannot drift on what a bare number or a bare path means.
 */
export function specFrom(arg: string | undefined, flags: TargetFlags): TargetSpec {
  if (flags.staged) return { kind: "staged" };
  if (flags.base) return { kind: "range", base: flags.base };
  if (arg === undefined) return { kind: "working-tree" };
  if (/^\d+$/.test(arg)) return { kind: "pr", number: Number(arg), repo: flags.repo };
  return { kind: "path", path: arg };
}

const g = (cwd: string) => ({ cwd, timeoutMs: 60_000, maxBytes: 8 * 1024 * 1024 });

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await exec(["git", "rev-parse", "--git-dir"], { cwd, timeoutMs: 5_000 });
  return r.code === 0;
}

export async function resolveTarget(spec: TargetSpec, cwd: string): Promise<ReviewTarget> {
  switch (spec.kind) {
    case "working-tree":
      return fromDiff(cwd, ["diff", "HEAD"], "working tree vs HEAD", "working-tree");
    case "staged":
      return fromDiff(cwd, ["diff", "--cached"], "staged changes", "staged");
    case "range": {
      const head = spec.head ?? "HEAD";
      // merge-base, not a two-dot diff: otherwise every commit that landed on the base since
      // the branch started shows up as if this branch had changed it.
      const base = (await execOrThrow(["git", "merge-base", spec.base, head], g(cwd))).trim();
      return fromDiff(cwd, ["diff", `${base}..${head}`], `${spec.base}...${head}`, "range");
    }
    case "path":
      return fromPath(spec.path, cwd);
    case "pr":
      return fromPr(spec, cwd);
    default: {
      const _never: never = spec;
      throw new Error(`unhandled target: ${JSON.stringify(_never)}`);
    }
  }
}

async function fromDiff(
  cwd: string,
  args: string[],
  label: string,
  kind: ReviewTarget["kind"],
): Promise<ReviewTarget> {
  if (!(await isGitRepo(cwd))) throw new Error(`${cwd} is not a git repository`);
  const numstat = await execOrThrow(["git", ...args, "--numstat", "--find-renames"], g(cwd));
  const files: FileChange[] = [];

  for (const line of numstat.split("\n").filter(Boolean)) {
    const [addRaw, delRaw, ...pathParts] = line.split("\t");
    const pathField = pathParts.join("\t");
    if (!pathField) continue;
    // Renames arrive as "old\tnew" in the path field.
    const [oldPath, newPath] = pathField.includes("\t")
      ? (pathField.split("\t") as [string, string])
      : [undefined, pathField];
    const path = newPath ?? pathField;
    if (BINARY_ADD.test(addRaw ?? "")) continue; // binary files: "-\t-\tpath"

    const patch = await execOrThrow(
      ["git", ...args, "--find-renames", "--", ...(oldPath ? [oldPath, path] : [path])],
      g(cwd),
    );
    files.push({
      path,
      oldPath,
      status: oldPath ? "renamed" : statusOf(patch),
      additions: Number(addRaw) || 0,
      deletions: Number(delRaw) || 0,
      patch,
    });
  }

  return { kind, label, files, wholeFile: false };
}

const BINARY_ADD = /^-$/;

function statusOf(patch: string): FileChange["status"] {
  if (/^new file mode/m.test(patch)) return "added";
  if (/^deleted file mode/m.test(patch)) return "deleted";
  return "modified";
}

/**
 * Path mode: no diff signal at all, so the whole file is the payload and the pipeline swaps in
 * a different prompt. Reviewing a file is a genuinely different question from reviewing a change.
 */
async function fromPath(path: string, cwd: string): Promise<ReviewTarget> {
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) throw new Error(`no such path: ${path}`);
  const files: FileChange[] = [];
  const isDir = statSync(abs).isDirectory();

  const paths: string[] = [];
  if (isDir) {
    const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,py,go,rs,java,rb,c,h,cc,cpp,hpp,cs,php,swift,kt,scala,sh}");
    for await (const rel of glob.scan({ cwd: abs, onlyFiles: true, dot: false })) {
      if (/(^|\/)(node_modules|\.git|dist|build|vendor)(\/|$)/.test(rel)) continue;
      paths.push(resolve(abs, rel));
      if (paths.length >= 200) break;
    }
  } else {
    paths.push(abs);
  }

  for (const p of paths) {
    const text = await Bun.file(p).text();
    files.push({
      path: relative(cwd, p),
      status: "modified",
      additions: text.split("\n").length,
      deletions: 0,
      patch: "",
    });
  }
  if (files.length === 0) throw new Error(`no reviewable source files under ${path}`);
  return { kind: "path", label: path, files, wholeFile: true };
}

/** GitHub PR via `gh` — no API token handling of our own, and it respects the user's auth. */
async function fromPr(spec: { number: number; repo?: string }, cwd: string): Promise<ReviewTarget> {
  const check = await exec(["gh", "--version"], { cwd, timeoutMs: 5_000 });
  if (check.code !== 0) {
    throw new Error("`gh` is required for PR targets. Install the GitHub CLI, or use --base instead.");
  }
  const repoArgs = spec.repo ? ["--repo", spec.repo] : [];
  const diff = await execOrThrow(["gh", "pr", "diff", String(spec.number), ...repoArgs], g(cwd));
  const files = splitDiff(diff);
  if (files.length === 0) throw new Error(`PR #${spec.number} has no reviewable text changes`);
  return { kind: "pr", label: `PR #${spec.number}`, files, wholeFile: false };
}

/** Split a combined unified diff into per-file patches. */
export function splitDiff(diff: string): FileChange[] {
  const out: FileChange[] = [];
  const chunks = diff.split(/^diff --git /m).slice(1);
  for (const chunk of chunks) {
    const body = `diff --git ${chunk}`;
    const m = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(body);
    if (!m) continue;
    const oldPath = m[1]!;
    const path = m[2]!;
    if (/^Binary files /m.test(body)) continue;
    const additions = (body.match(/^\+(?!\+\+)/gm) ?? []).length;
    const deletions = (body.match(/^-(?!--)/gm) ?? []).length;
    out.push({
      path,
      oldPath: oldPath !== path ? oldPath : undefined,
      status: oldPath !== path ? "renamed" : statusOf(body),
      additions,
      deletions,
      patch: body,
    });
  }
  return out;
}

/** Render the target as the payload the model reviews. */
export function renderTarget(target: ReviewTarget, files = target.files): string {
  const header = `# Under review: ${target.label}\n\n${files.length} file(s).`;
  if (target.wholeFile) {
    return `${header}\n\nThere is no diff — review these files as a whole. Read each one with \`read_file\`:\n\n${files
      .map((f) => `- ${f.path} (${f.additions} lines)`)
      .join("\n")}`;
  }
  const body = files
    .map((f) => `## ${f.path} (+${f.additions}/-${f.deletions}, ${f.status})\n\n\`\`\`diff\n${f.patch}\n\`\`\``)
    .join("\n\n");
  return `${header}\n\n${body}`;
}
