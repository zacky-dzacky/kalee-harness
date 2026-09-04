import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findResource, requireResource, resourceRoots } from "../src/core/roots.ts";
import { loadPrompt } from "../src/core/identity.ts";
import { loadSkills } from "../src/core/skills.ts";
import { listCases, loadExpected } from "../src/eval/run.ts";
import { loadRegistry } from "../src/model/registry.ts";

const originalHome = process.env.KALEE_HOME;
afterEach(() => {
  if (originalHome === undefined) delete process.env.KALEE_HOME;
  else process.env.KALEE_HOME = originalHome;
});

describe("resource resolution", () => {
  test("finds the runtime data the harness ships with", () => {
    expect(findResource("models.yaml")).not.toBeNull();
    expect(findResource("prompts/identity.md")).not.toBeNull();
    expect(findResource("skills/code-review/SKILL.md")).not.toBeNull();
  });

  test("KALEE_HOME takes precedence", () => {
    process.env.KALEE_HOME = "/tmp/kalee-home-test";
    expect(resourceRoots()[0]).toBe("/tmp/kalee-home-test");
  });

  test("a missing resource names the roots it searched", () => {
    expect(() => requireResource("definitely-not-here.yaml")).toThrow(/Searched:/);
  });

  test("roots are deduplicated", () => {
    const roots = resourceRoots();
    expect(new Set(roots).size).toBe(roots.length);
  });
});

describe("runtime data loads", () => {
  test("both prompts load and are non-trivial", async () => {
    const identity = await loadPrompt("identity");
    const verify = await loadPrompt("verify");
    expect(identity.length).toBeGreaterThan(200);
    expect(verify).toContain("confirmed");
    expect(verify).toContain("rejected");
  });

  test("a missing prompt fails with an actionable message", async () => {
    await expect(loadPrompt("nope")).rejects.toThrow(/Searched:/);
  });

  test("the code-review skill loads with its tool allowlist", async () => {
    const skills = await loadSkills(process.cwd());
    const skill = skills.get("code-review");
    expect(skill).toBeDefined();
    expect(skill!.tools).toContain("report_finding");
    // The skill must not hand the reviewer a way to change the repo.
    expect(skill!.tools).not.toContain("bash");
    expect(skill!.body.length).toBeGreaterThan(500);
  });

  test("the registry parses and defines the roles the pipeline needs", async () => {
    const reg = await loadRegistry(process.cwd());
    expect(reg.models.length).toBeGreaterThan(0);
    expect(reg.roles.scan).toBeTruthy();
    expect(reg.roles.verify).toBeTruthy();
    for (const m of reg.models) {
      expect(m.caps.maxContext).toBeGreaterThan(0);
      expect(typeof m.caps.nativeToolCalls).toBe("boolean");
    }
  });
});

describe("fixtures", () => {
  test("there are at least 8 cases, including two clean ones", async () => {
    const cases = await listCases();
    expect(cases.length).toBeGreaterThanOrEqual(8);

    let clean = 0;
    for (const name of cases) {
      const expected = await loadExpected(name);
      expect(expected.case).toBe(name);
      if (expected.bugs.length === 0) clean++;
    }
    // Clean fixtures are what stop a reviewer scoring well by flagging everything.
    expect(clean).toBeGreaterThanOrEqual(2);
  });

  test("every seeded bug points at a line that exists in its file", async () => {
    const dir = findResource("fixtures")!;
    for (const name of await listCases()) {
      const expected = await loadExpected(name);
      for (const bug of expected.bugs) {
        const path = join(dir, name, "repo", bug.file);
        expect(existsSync(path)).toBe(true);
        const lines = (await Bun.file(path).text()).split("\n").length;
        expect(bug.line).toBeLessThanOrEqual(lines);
      }
    }
  });
});
