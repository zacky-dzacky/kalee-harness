import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

/**
 * Where the harness finds its runtime data: `prompts/`, `skills/`, `models.yaml`, `fixtures/`.
 *
 * These are read from disk rather than bundled as constants, deliberately — prompt iteration
 * is most of the real work in an agent harness and must not require a rebuild. That choice has
 * a consequence `bun build --compile` makes obvious: inside a compiled binary `import.meta.url`
 * is a virtual path, so deriving the root from the source location alone finds nothing. Hence a
 * search path rather than a single directory.
 */
function sourceRoot(): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    // src/core/roots.ts -> the repo root.
    const root = dirname(dirname(dirname(here)));
    // The existence check is what distinguishes a real checkout from a compiled binary's
    // virtual filesystem, without having to recognise Bun's internal path format.
    return existsSync(join(root, "prompts")) ? root : null;
  } catch {
    return null;
  }
}

/** Search order, nearest first. `KALEE_HOME` wins so a packaged install can redirect it. */
export function resourceRoots(): string[] {
  const roots: string[] = [];
  if (process.env.KALEE_HOME) roots.push(resolve(process.env.KALEE_HOME));
  const src = sourceRoot();
  if (src) roots.push(src);
  // A distributed binary sits next to its prompts/ and skills/ directories.
  roots.push(dirname(process.execPath));
  roots.push(join(homedir(), ".kalee"));
  return [...new Set(roots)];
}

export function findResource(rel: string): string | null {
  for (const root of resourceRoots()) {
    const p = join(root, rel);
    if (existsSync(p)) return p;
  }
  return null;
}

export function requireResource(rel: string): string {
  const found = findResource(rel);
  if (found) return found;
  throw new Error(
    `cannot find \`${rel}\`. Searched: ${resourceRoots().join(", ")}. ` +
      "Set KALEE_HOME to the directory holding prompts/, skills/ and models.yaml.",
  );
}
