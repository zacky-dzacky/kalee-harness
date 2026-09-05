/**
 * Terminal text helpers, shared by the review renderer and the REPL.
 *
 * Extracted so there is one wrapping implementation rather than a copy per renderer — the two
 * had already started to drift on whether the caller or the wrapper owns the first line's
 * indent.
 */

/**
 * Word-wrap to `width`, indenting every line *after* the first. The caller owns the first
 * line's indent, which is what lets a label and its wrapped body share a line.
 */
export function wrap(text: string, width: number, indent = ""): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.join(`\n${indent}`);
}

/** Terminal width, clamped to something sane. Pipes and dumb terminals report nothing. */
export function terminalWidth(fallback = 80): number {
  const cols = process.stdout.columns;
  if (!cols || cols < 20) return fallback;
  return Math.min(cols, 120);
}

/** Single-line preview: collapse whitespace, then cut with an ellipsis. */
export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1))}…`;
}

/** Path as a human writes it: `~` for home, relative when it is under the cwd. */
export function tildify(path: string, home: string): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
