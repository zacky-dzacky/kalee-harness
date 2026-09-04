import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/tools/exec.ts";
import { renderTarget, resolveTarget, splitDiff } from "../src/review/target.ts";

/** A real git repository, built in the test — target resolution is mostly git semantics. */
let repo: string;

const git = async (...args: string[]) => {
  const r = await exec(["git", ...args], { cwd: repo, timeoutMs: 20_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

beforeAll(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "kalee-git-")));
  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");

  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(repo, "src", "b.ts"), "export const b = 2;\n");
  await git("add", ".");
  await git("commit", "-m", "initial");

  // A branch with its own commit, plus a later commit on main. A two-dot diff would wrongly
  // attribute the main-only change to the branch; merge-base must not.
  await git("checkout", "-b", "feature");
  await writeFile(join(repo, "src", "a.ts"), "export const a = 1;\nexport const c = 3;\n");
  await git("commit", "-am", "feature change");

  await git("checkout", "main");
  await writeFile(join(repo, "src", "b.ts"), "export const b = 2;\nexport const d = 4;\n");
  await git("commit", "-am", "main moves on");
  await git("checkout", "feature");
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("resolveTarget", () => {
  test("range uses merge-base, not a two-dot diff", async () => {
    const target = await resolveTarget({ kind: "range", base: "main" }, repo);
    const paths = target.files.map((f) => f.path);
    // b.ts changed on main after the branch point; it is not this branch's work.
    expect(paths).toEqual(["src/a.ts"]);
    expect(target.files[0]!.additions).toBe(1);
    expect(target.wholeFile).toBe(false);
  });

  test("working tree diffs uncommitted changes against HEAD", async () => {
    await writeFile(join(repo, "src", "b.ts"), "export const b = 99;\n");
    const target = await resolveTarget({ kind: "working-tree" }, repo);
    expect(target.files.map((f) => f.path)).toContain("src/b.ts");
    expect(target.files[0]!.patch).toContain("99");
    await exec(["git", "checkout", "--", "src/b.ts"], { cwd: repo, timeoutMs: 10_000 });
  });

  test("staged mode sees only the index", async () => {
    await writeFile(join(repo, "src", "staged.ts"), "export const s = 1;\n");
    await git("add", "src/staged.ts");
    await writeFile(join(repo, "src", "unstaged.ts"), "export const u = 1;\n");

    const target = await resolveTarget({ kind: "staged" }, repo);
    const paths = target.files.map((f) => f.path);
    expect(paths).toContain("src/staged.ts");
    expect(paths).not.toContain("src/unstaged.ts");

    await git("reset");
    await rm(join(repo, "src", "staged.ts"));
    await rm(join(repo, "src", "unstaged.ts"));
  });

  test("added files are detected as added", async () => {
    await writeFile(join(repo, "src", "new.ts"), "export const n = 1;\n");
    await git("add", "src/new.ts");
    const target = await resolveTarget({ kind: "staged" }, repo);
    expect(target.files.find((f) => f.path === "src/new.ts")?.status).toBe("added");
    await git("reset");
    await rm(join(repo, "src", "new.ts"));
  });

  test("path mode has no diff signal and carries whole files", async () => {
    const target = await resolveTarget({ kind: "path", path: "src" }, repo);
    expect(target.wholeFile).toBe(true);
    expect(target.files.length).toBeGreaterThanOrEqual(2);
    expect(target.files.every((f) => f.patch === "")).toBe(true);
  });

  test("path mode accepts a single file", async () => {
    const target = await resolveTarget({ kind: "path", path: "src/a.ts" }, repo);
    expect(target.files).toHaveLength(1);
    expect(target.files[0]!.path).toBe("src/a.ts");
  });

  test("a missing path is an error, not an empty review", async () => {
    await expect(resolveTarget({ kind: "path", path: "nope" }, repo)).rejects.toThrow(/no such path/);
  });

  test("a non-git directory is rejected clearly", async () => {
    const plain = await mkdtemp(join(tmpdir(), "kalee-plain-"));
    await expect(resolveTarget({ kind: "working-tree" }, plain)).rejects.toThrow(/not a git repository/);
    await rm(plain, { recursive: true, force: true });
  });
});

describe("renderTarget", () => {
  test("renders diffs for a change target", async () => {
    const target = await resolveTarget({ kind: "range", base: "main" }, repo);
    const rendered = renderTarget(target);
    expect(rendered).toContain("src/a.ts");
    expect(rendered).toContain("```diff");
  });

  test("tells the model to read the files in path mode", async () => {
    const target = await resolveTarget({ kind: "path", path: "src" }, repo);
    const rendered = renderTarget(target);
    expect(rendered).toContain("no diff");
    expect(rendered).not.toContain("```diff");
  });
});

describe("splitDiff", () => {
  test("splits a combined PR diff into per-file patches", () => {
    const diff = `diff --git a/src/one.ts b/src/one.ts
index 1111111..2222222 100644
--- a/src/one.ts
+++ b/src/one.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 const c = 3;
diff --git a/src/two.ts b/src/two.ts
index 3333333..4444444 100644
--- a/src/two.ts
+++ b/src/two.ts
@@ -1,2 +1,1 @@
 const d = 4;
-const e = 5;
`;
    const files = splitDiff(diff);
    expect(files.map((f) => f.path)).toEqual(["src/one.ts", "src/two.ts"]);
    expect(files[0]!.additions).toBe(1);
    expect(files[1]!.deletions).toBe(1);
    expect(files[0]!.patch).toContain("const b = 2;");
  });

  test("skips binary files", () => {
    const diff = `diff --git a/logo.png b/logo.png
index 1111111..2222222 100644
Binary files a/logo.png and b/logo.png differ
`;
    expect(splitDiff(diff)).toHaveLength(0);
  });

  test("detects a rename", () => {
    const diff = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
`;
    const files = splitDiff(diff);
    expect(files[0]).toMatchObject({ path: "new.ts", oldPath: "old.ts", status: "renamed" });
  });
});
