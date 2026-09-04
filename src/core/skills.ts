import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { resourceRoots } from "./roots.ts";

/**
 * Loadable skills (LAYERS.md). A skill is a directory with a `SKILL.md` carrying YAML
 * frontmatter.
 *
 * Progressive disclosure is the point: **descriptions** sit in context so the agent knows what
 * exists, and a **body** is loaded only when that skill is selected. Putting every body in
 * context would defeat the mechanism.
 */
export interface Skill {
  name: string;
  description: string;
  /** Optional tool allowlist — the skill narrows what the pass can reach for. */
  tools?: string[];
  body: string;
  path: string;
}

export interface Frontmatter {
  name?: string;
  description?: string;
  tools?: string[];
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkill(source: string, path: string): Skill {
  const m = FM.exec(source);
  if (!m) throw new Error(`${path}: SKILL.md must start with YAML frontmatter delimited by ---`);
  const fm = (parse(m[1] ?? "") ?? {}) as Frontmatter;
  if (!fm.name) throw new Error(`${path}: frontmatter is missing \`name\``);
  if (!fm.description) throw new Error(`${path}: frontmatter is missing \`description\``);
  return {
    name: fm.name,
    description: fm.description,
    tools: fm.tools,
    body: (m[2] ?? "").trim(),
    path,
  };
}

/** Skill search path, nearest last so a project skill shadows a bundled one of the same name. */
export function skillDirs(cwd: string): string[] {
  // Resource roots are ordered nearest-first, so reverse them: a project skill must shadow a
  // bundled one of the same name, and `loadSkills` lets later directories win.
  const roots = resourceRoots().map((r) => join(r, "skills")).reverse();
  return [...roots, join(homedir(), ".kalee", "skills"), join(cwd, ".kalee", "skills")]
    .filter(existsSync)
    .filter((v, i, a) => a.indexOf(v) === i);
}

export async function loadSkills(cwd: string): Promise<Map<string, Skill>> {
  const out = new Map<string, Skill>();
  for (const dir of skillDirs(cwd)) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name, "SKILL.md");
      if (!existsSync(path)) continue;
      const skill = parseSkill(await readFile(path, "utf8"), path);
      out.set(skill.name, skill); // later dirs shadow earlier ones
    }
  }
  return out;
}

export async function requireSkill(cwd: string, name: string): Promise<Skill> {
  const skills = await loadSkills(cwd);
  const skill = skills.get(name);
  if (!skill) {
    const known = [...skills.keys()].join(", ") || "none found";
    throw new Error(`unknown skill \`${name}\`. Available: ${known}`);
  }
  return skill;
}

/** The always-in-context half: one line per skill, bodies withheld. */
export function manifest(skills: Iterable<Skill>): string {
  const lines = [...skills].map((s) => `- **${s.name}** — ${s.description}`);
  return lines.length ? `## Available skills\n\n${lines.join("\n")}` : "";
}
