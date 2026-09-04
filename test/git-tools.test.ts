import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/tools/exec.ts";
import { gitBlameTool, gitDiffTool, gitShowTool } from "../src/tools/git.ts";
import { grepTool } from "../src/tools/grep.ts";
import { globTool } from "../src/tools/glob.ts";
import { readonlyPolicy } from "../src/core/policy.ts";
import { nullTrace } from "../src/core/trace.ts";
import type { ToolCtx } from "../src/tools/types.ts";

/** The git tools shell out, so only running them proves the argv is valid. */
let repo: string;
const ctx = (): ToolCtx => ({
  cwd: repo,
  policy: readonlyPolicy(),
  trace: nullTrace(),
  signal: new AbortController().signal,
});

const git = async (...args: string[]) => {
  const r = await exec(["git", ...args], { cwd: repo, timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

beforeAll(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "kalee-tools-")));
  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "a.ts"), "export const alpha = 1;\nexport const beta = 2;\n");
  await git("add", ".");
  await git("commit", "-m", "initial");
  await writeFile(join(repo, "src", "a.ts"), "export const alpha = 1;\nexport const beta = 22;\n");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("git tools", () => {
  test("git_diff shows working-tree changes", async () => {
    const out = await gitDiffTool.call({}, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("beta = 22");
  });

  test("git_diff scoped to a path", async () => {
    const out = await gitDiffTool.call({ path: "src/a.ts" }, ctx());
    expect(out.content).toContain("src/a.ts");
  });

  test("git_diff rejects a path outside the jail", async () => {
    const out = await gitDiffTool.call({ path: "../../../etc" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/escapes/);
  });

  test("git_show reads a file at a revision", async () => {
    const out = await gitShowTool.call({ ref: "HEAD:src/a.ts" }, ctx());
    expect(out.isError).toBeFalsy();
    // The committed version, not the working tree.
    expect(out.content).toContain("beta = 2;");
  });

  test("git_show reports a bad ref as an error result", async () => {
    const out = await gitShowTool.call({ ref: "nope123:src/a.ts" }, ctx());
    expect(out.isError).toBe(true);
  });

  test("git_blame runs and attributes lines", async () => {
    const out = await gitBlameTool.call({ path: "src/a.ts" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("alpha");
    expect(out.content).toContain("Test");
  });

  test("git_blame accepts a line range", async () => {
    const out = await gitBlameTool.call({ path: "src/a.ts", startLine: 1, endLine: 1 }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("alpha");
    expect(out.content).not.toContain("beta");
  });
});

describe("search tools", () => {
  test("grep finds matches with path:line", async () => {
    const out = await grepTool.call({ pattern: "alpha" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toMatch(/src\/a\.ts:1/);
  });

  test("grep reports no matches plainly", async () => {
    const out = await grepTool.call({ pattern: "zzzznotthere" }, ctx());
    expect(out.content).toMatch(/no matches/);
  });

  test("grep rejects an invalid regex instead of throwing", async () => {
    const out = await grepTool.call({ pattern: "([unclosed" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/invalid regex/);
  });

  test("glob lists matching files", async () => {
    const out = await globTool.call({ pattern: "**/*.ts" }, ctx());
    expect(out.content).toContain("src/a.ts");
  });

  test("glob reports an empty result plainly", async () => {
    const out = await globTool.call({ pattern: "**/*.nope" }, ctx());
    expect(out.content).toMatch(/no files match/);
  });
});
