import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { requireResource } from "./roots.ts";

/**
 * Durable identity (LAYERS.md). Read from disk at run time, never bundled as a constant —
 * prompt iteration is where most of the real work in a harness happens, and it must not
 * require a rebuild.
 */
export async function loadPrompt(name: string): Promise<string> {
  return (await readFile(requireResource(join("prompts", `${name}.md`)), "utf8")).trim();
}

/**
 * `KALEE.md` is the project identity overlay: repo-specific conventions that should shape
 * every review of this codebase. User-level first, then project, so the project wins.
 */
export async function loadOverlay(cwd: string): Promise<string | null> {
  const parts: string[] = [];
  for (const p of [join(homedir(), ".kalee", "KALEE.md"), join(cwd, "KALEE.md")]) {
    if (existsSync(p)) {
      const body = (await readFile(p, "utf8")).trim();
      if (body) parts.push(body);
    }
  }
  return parts.length ? parts.join("\n\n---\n\n") : null;
}
