import type { CacheSpan } from "../model/ir.ts";
import type { Skill } from "./skills.ts";

/**
 * Compiled context (LAYERS.md: Identity & Behaviour).
 *
 * The ordering rule is the whole job: **stable first, volatile last**. Everything that varies
 * per run — timestamps, the diff, the question — must land after the final cache breakpoint,
 * or the prefix changes every run and caching silently never hits. That failure costs money
 * and is invisible, so the builder enforces the order rather than trusting callers.
 */
export class ContextBuilder {
  private stable: string[] = [];
  private volatile: string[] = [];
  private sealed = false;

  /** Cacheable prefix content: identity, skill bodies, tool conventions, repo map. */
  addStable(section: string | null | undefined): this {
    if (this.sealed) throw new Error("addStable after volatile content would break the cache prefix");
    if (section?.trim()) this.stable.push(section.trim());
    return this;
  }

  /** Per-run content. Everything after this point is outside the cached prefix. */
  addVolatile(section: string | null | undefined): this {
    this.sealed = true;
    if (section?.trim()) this.volatile.push(section.trim());
    return this;
  }

  identity(prompt: string): this {
    return this.addStable(prompt);
  }

  skill(skill: Skill): this {
    return this.addStable(`# Skill: ${skill.name}\n\n${skill.body}`);
  }

  overlay(text: string | null): this {
    return text ? this.addStable(`# Project conventions (KALEE.md)\n\n${text}`) : this;
  }

  /**
   * Build the system prompt as cache spans. The breakpoint goes at the end of the stable
   * block; volatile spans follow it uncached.
   */
  build(): CacheSpan[] {
    const spans: CacheSpan[] = [];
    if (this.stable.length) {
      spans.push({ text: this.stable.join("\n\n"), cache: true });
    }
    for (const v of this.volatile) spans.push({ text: v });
    return spans;
  }
}

const IGNORED = /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|target|\.kalee)(\/|$)/;

/**
 * A compact repository map: the directory shape, not the contents. Cheap orientation that
 * saves the agent a round of `glob` calls, and stable enough to sit inside the cached prefix.
 */
export async function repoMap(cwd: string, limit = 120): Promise<string> {
  const glob = new Bun.Glob("**/*");
  const dirs = new Map<string, number>();
  let files = 0;
  for await (const rel of glob.scan({ cwd, dot: false, onlyFiles: true })) {
    if (IGNORED.test(rel)) continue;
    files++;
    const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : ".";
    dirs.set(dir, (dirs.get(dir) ?? 0) + 1);
    if (files > 20_000) break; // bound the scan on a huge repo
  }
  const top = [...dirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  const body = top.map(([d, n]) => `${d}/ (${n})`).join("\n");
  return `# Repository map\n\n${files} files.\n\n${body}`;
}
