import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Resolve a caller-supplied path inside the jail.
 *
 * Symlinks are resolved before the containment check, because a symlink pointing outside the
 * jail is the interesting escape — `../` is only the obvious one.
 */
export function jailed(cwd: string, p: string): string {
  const root = realish(resolve(cwd));
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const real = realish(abs);
  const rel = relative(root, real);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes the working directory: ${p}`);
  }
  return real;
}

/** realpath, tolerating a path that does not exist yet (resolve its nearest real ancestor). */
function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = resolve(p, "..");
    if (parent === p) return p;
    return join(realish(parent), p.slice(parent.length + 1));
  }
}

export function display(cwd: string, abs: string): string {
  const rel = relative(cwd, abs);
  return rel === "" ? "." : rel;
}
