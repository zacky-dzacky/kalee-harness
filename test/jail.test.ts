import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jailed } from "../src/tools/paths.ts";
import { readFileTool } from "../src/tools/read_file.ts";
import { readonlyPolicy } from "../src/core/policy.ts";
import { nullTrace } from "../src/core/trace.ts";
import type { ToolCtx } from "../src/tools/types.ts";

let root: string;
let outside: string;

beforeAll(async () => {
  // realpath up front: on macOS /var is a symlink to /private/var, and `jailed` returns
  // resolved paths by design.
  const base = await realpath(await mkdtemp(join(tmpdir(), "kalee-jail-")));
  root = join(base, "repo");
  outside = join(base, "secrets");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(root, "inside.txt"), "safe\n");
  await mkdir(join(root, "sub"), { recursive: true });
  await writeFile(join(root, "sub", "nested.txt"), "also safe\n");
  await writeFile(join(outside, "private.key"), "SECRET\n");
  // A symlink pointing out of the jail — the escape that `../` checks alone would miss.
  await symlink(join(outside, "private.key"), join(root, "link-out"));
  await symlink(outside, join(root, "dir-out"));
});

afterAll(async () => {
  await rm(join(root, ".."), { recursive: true, force: true });
});

const ctx = (): ToolCtx => ({
  cwd: root,
  policy: readonlyPolicy(),
  trace: nullTrace(),
  signal: new AbortController().signal,
});

describe("path jail", () => {
  test("allows paths inside the jail", () => {
    expect(jailed(root, "inside.txt")).toBe(join(root, "inside.txt"));
    expect(jailed(root, "./sub/nested.txt")).toBe(join(root, "sub", "nested.txt"));
    expect(jailed(root, "sub/../inside.txt")).toBe(join(root, "inside.txt"));
  });

  test("rejects relative traversal", () => {
    expect(() => jailed(root, "../secrets/private.key")).toThrow(/escapes/);
    expect(() => jailed(root, "sub/../../secrets/private.key")).toThrow(/escapes/);
    expect(() => jailed(root, "../../../../etc/passwd")).toThrow(/escapes/);
  });

  test("rejects absolute paths outside the jail", () => {
    expect(() => jailed(root, join(outside, "private.key"))).toThrow(/escapes/);
    expect(() => jailed(root, "/etc/passwd")).toThrow(/escapes/);
  });

  test("rejects a symlink pointing outside the jail", () => {
    // The whole point of resolving symlinks before the containment check.
    expect(() => jailed(root, "link-out")).toThrow(/escapes/);
    expect(() => jailed(root, "dir-out/private.key")).toThrow(/escapes/);
  });

  test("allows an absolute path that is inside the jail", () => {
    expect(jailed(root, join(root, "inside.txt"))).toBe(join(root, "inside.txt"));
  });
});

describe("read_file honours the jail", () => {
  test("reads an inside file with line numbers", async () => {
    const out = await readFileTool.call({ path: "inside.txt" }, ctx());
    expect(out.isError).toBeFalsy();
    expect(out.content).toContain("1\tsafe");
  });

  test("refuses to read through a symlink out of the jail", async () => {
    const out = await readFileTool.call({ path: "link-out" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/escapes/);
    expect(out.content).not.toContain("SECRET");
  });

  test("refuses traversal", async () => {
    const out = await readFileTool.call({ path: "../secrets/private.key" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).not.toContain("SECRET");
  });

  test("reports a missing file as an error result, not a throw", async () => {
    const out = await readFileTool.call({ path: "nope.txt" }, ctx());
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/no such file/);
  });
});
