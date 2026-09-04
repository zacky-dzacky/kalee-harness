import { spawn } from "node:child_process";
import { ProviderError } from "../model/ir.ts";

/**
 * The sandbox seam (LAYERS.md: Execution & Sandbox — partial in v1).
 *
 * v1 enforces: cwd jail (the caller's), wall-clock timeout that kills the **whole process
 * group**, output byte cap, and a command denylist. Shaped so `sandbox-exec` and landlock can
 * drop in behind this same signature later without touching a single caller.
 *
 * Spawning goes through `node:child_process` rather than `Bun.spawn` for one reason:
 * `detached: true`. Bun.spawn leaves the child in the *harness's* process group, so the
 * `kill(-pid)` that reaps a runaway pipeline would kill Kalee itself. Verified, not assumed.
 */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
  stdin?: string;
  env?: Record<string, string>;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Commands that are destructive, exfiltrating, or privilege-escalating regardless of intent.
 * This is a backstop, not the security boundary — `core/policy.ts` is the boundary.
 */
const DENY: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rf]/,
  /\bsudo\b/,
  /\bshutdown\b|\breboot\b|\bhalt\b/,
  /\bmkfs\b|\bdd\s+if=/,
  /\bchmod\s+(-R\s+)?[0-7]*777\b/,
  /:\(\)\s*\{.*\}\s*;/, // fork bomb
  /\bgit\s+push\b/,
  /\bcurl\b[^|]*\|\s*(ba)?sh\b/,
  /\bnpm\s+publish\b|\bbun\s+publish\b/,
  />\s*\/dev\/(sd|disk)/,
];

export function denied(command: string): string | null {
  for (const re of DENY) {
    if (re.test(command)) return `command matches the denylist (${re.source})`;
  }
  return null;
}

/** Run an argv directly — no shell, so no quoting or injection surface. */
export function exec(argv: string[], opts: ExecOptions): Promise<ExecResult> {
  return spawnCapped(argv, opts);
}

/** Run a shell command line. Only reachable through the policy-gated `bash` tool. */
export function shell(command: string, opts: ExecOptions): Promise<ExecResult> {
  return spawnCapped(["/bin/sh", "-c", command], opts);
}

async function spawnCapped(argv: string[], opts: ExecOptions): Promise<ExecResult> {
  const started = Date.now();
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("exec: empty argv");

  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    // Own process group, so the timeout can reap grandchildren too.
    detached: true,
    stdio: [opts.stdin ? "pipe" : "ignore", "pipe", "pipe"],
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
  });

  if (opts.stdin && child.stdin) {
    child.stdin.end(opts.stdin);
  }

  const stdout = capture(child.stdout, maxBytes);
  const stderr = capture(child.stderr, maxBytes);

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killGroup(child.pid);
  }, timeoutMs);
  const onAbort = () => killGroup(child.pid);
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const code = await new Promise<number>((res, rej) => {
      child.on("error", rej);
      child.on("close", (c, sig) => res(c ?? (sig ? 137 : 0)));
    });
    const out = await stdout;
    const err = await stderr;
    return {
      stdout: out.text,
      stderr: err.text,
      code,
      timedOut,
      truncated: out.truncated || err.truncated,
      durationMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Kill the process group, not just the child. `sh -c "foo | bar"` leaves grandchildren
 * holding the pipe open, and killing only the shell hangs the read forever.
 */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

function capture(
  stream: NodeJS.ReadableStream | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!stream) return Promise.resolve({ text: "", truncated: false });
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let truncated = false;
    stream.on("data", (c: Buffer) => {
      if (total >= maxBytes) {
        // Keep draining rather than pausing: a child blocked on a full pipe never exits.
        truncated = true;
        return;
      }
      const slice = total + c.length > maxBytes ? c.subarray(0, maxBytes - total) : c;
      if (slice.length < c.length) truncated = true;
      chunks.push(slice);
      total += slice.length;
    });
    const done = () => resolve({ text: Buffer.concat(chunks).toString("utf8"), truncated });
    stream.on("end", done);
    stream.on("error", done);
  });
}

/** Convenience for the git wrappers: run and throw a typed error on failure. */
export async function execOrThrow(argv: string[], opts: ExecOptions): Promise<string> {
  const r = await exec(argv, opts);
  if (r.code !== 0) {
    throw new ProviderError(
      `\`${argv.join(" ")}\` failed (exit ${r.code}): ${r.stderr.trim() || r.stdout.trim()}`,
      "bad_request",
      "exec",
      false,
    );
  }
  return r.stdout;
}
