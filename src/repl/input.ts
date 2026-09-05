import { createInterface, type Interface } from "node:readline";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * The single owner of stdin.
 *
 * There must be exactly one: `readline` takes over the TTY, and the older
 * `for await (const line of console)` idiom consumes the *global* stdin iterator. Two readers
 * in one process do not fail loudly — they silently split the user's keystrokes between them.
 * So every prompt in the CLI, including tool-permission confirmations raised from inside an
 * agent turn, goes through this class.
 */
const HISTORY_PATH = join(homedir(), ".kalee", "history");
const HISTORY_MAX = 500;

export interface CompletionSource {
  /** Command names, with their leading slash. */
  commands(): string[];
  /** Completions for the argument of `command`, e.g. model ids for `/model`. */
  argsFor(command: string): string[];
}

export interface LineReaderOptions {
  completion?: CompletionSource;
  /**
   * Where the prompt and the echoed line are drawn. Defaults to stdout for the REPL; the
   * one-shot commands pass stderr, because a permission prompt must not land in the middle of
   * `kalee review --format json`.
   */
  output?: NodeJS.WritableStream;
}

export class LineReader {
  private rl: Interface;
  private readonly completion?: CompletionSource;
  private readonly output: NodeJS.WritableStream;
  private closed = false;
  private interrupt: (() => void) | null = null;
  /**
   * Lines that arrived with no reader waiting.
   *
   * `rl.question()` captures only the *next* line, which is fine on a terminal where lines
   * appear one keystroke-burst at a time, and silently lossy on a pipe: the whole input is
   * emitted at once and everything after the first line falls on the floor, then the interface
   * closes at EOF. Buffering the `line` event instead makes the two cases identical.
   */
  private queue: string[] = [];
  private waiter: ((line: string | null) => void) | null = null;
  private sigints = 0;
  private paused = false;
  private readonly tty: boolean;

  constructor(opts: LineReaderOptions = {}) {
    this.completion = opts.completion;
    this.output = opts.output ?? process.stdout;
    this.tty = Boolean(process.stdin.isTTY);
    this.rl = createInterface({
      input: process.stdin,
      output: this.output,
      terminal: this.tty,
      historySize: HISTORY_MAX,
      completer: (line: string) => this.complete(line),
    });

    this.rl.on("line", (line: string) => {
      const waiter = this.waiter;
      if (waiter) {
        this.waiter = null;
        waiter(line);
      } else {
        this.queue.push(line);
      }
    });

    this.rl.once("close", () => {
      this.closed = true;
      // Whoever is waiting gets EOF; anything already queued is still theirs to collect.
      this.waiter?.(null);
      this.waiter = null;
    });

    this.rl.on("SIGINT", () => this.onSigint());
  }

  /** Load persisted history. Best-effort: a missing or unreadable file is not an error. */
  async loadHistory(): Promise<void> {
    if (!this.tty || !existsSync(HISTORY_PATH)) return;
    try {
      const lines = (await readFile(HISTORY_PATH, "utf8")).split("\n").filter(Boolean);
      // The file is append-only during a session, so trim it here rather than on every write.
      if (lines.length > HISTORY_MAX * 2) {
        await writeFile(HISTORY_PATH, `${lines.slice(-HISTORY_MAX).join("\n")}\n`, "utf8");
      }
      // readline stores history newest-first.
      (this.rl as unknown as { history: string[] }).history = lines.reverse().slice(0, HISTORY_MAX);
    } catch {
      /* history is a convenience, never a reason to fail startup */
    }
  }

  private async remember(line: string): Promise<void> {
    if (!this.tty || !line.trim()) return;
    try {
      await mkdir(dirname(HISTORY_PATH), { recursive: true });
      await appendFile(HISTORY_PATH, `${line}\n`, "utf8");
    } catch {
      /* ignore */
    }
  }

  /** Read one line. `null` means EOF (Ctrl-D) or a closed interface — the caller should stop. */
  async prompt(text: string): Promise<string | null> {
    // Drain the buffer before honouring EOF: on a pipe the interface is already closed by the
    // time the first line is asked for.
    const queued = this.queue.shift();
    if (queued !== undefined) {
      this.sigints = 0;
      void this.remember(queued);
      return queued;
    }
    if (this.closed) return null;

    this.rl.setPrompt(text);
    this.rl.prompt();
    const answer = await new Promise<string | null>((resolve) => {
      this.waiter = resolve;
    });
    if (answer === null) return null;
    this.sigints = 0;
    void this.remember(answer);
    return answer;
  }

  /**
   * Yes/no, defaulting to no. Works mid-turn: the input is paused while an agent turn streams,
   * and a permission prompt has to be able to borrow it back and then hand it over again.
   */
  async confirm(question: string): Promise<boolean> {
    const wasPaused = this.paused;
    if (wasPaused) this.resumeInput();
    const answer = await this.prompt(question);
    if (wasPaused) this.pauseInput();
    return answer !== null && /^y(es)?$/i.test(answer.trim());
  }

  /**
   * Hand stdin over to the running turn: line editing off, and Ctrl-C routed to `onInterrupt`
   * instead of the prompt's two-press exit.
   */
  beginTurn(onInterrupt: () => void): void {
    this.interrupt = onInterrupt;
    this.pauseInput();
  }

  endTurn(): void {
    this.interrupt = null;
    this.resumeInput();
  }

  /**
   * Pausing releases the TTY from raw mode, which is what lets the terminal deliver a real
   * SIGINT to the process while a turn is streaming. In raw mode Ctrl-C is just a byte, and
   * with the input paused nobody is reading bytes.
   */
  private pauseInput(): void {
    if (this.paused || this.closed) return;
    this.paused = true;
    this.rl.pause();
    if (this.tty && process.stdin.isRaw) process.stdin.setRawMode(false);
    process.on("SIGINT", this.onProcessSigint);
  }

  private resumeInput(): void {
    if (!this.paused) return;
    this.paused = false;
    process.off("SIGINT", this.onProcessSigint);
    // Reached at EOF on a pipe, where the interface closed while the turn was still running.
    // Resuming a closed interface throws, and a finished turn is no place to fail.
    if (this.closed) return;
    if (this.tty && !process.stdin.isRaw) process.stdin.setRawMode(true);
    this.rl.resume();
  }

  private onProcessSigint = (): void => {
    this.interrupt?.();
  };

  private onSigint(): void {
    if (this.interrupt) {
      this.interrupt();
      return;
    }
    // Ctrl-C with something typed clears the line; on an empty line it takes two to leave, so
    // a reflexive Ctrl-C does not throw away a session.
    if (this.rl.line.length > 0) {
      this.rl.write(null, { ctrl: true, name: "u" });
      this.sigints = 0;
      return;
    }
    if (++this.sigints >= 2) {
      this.close();
      return;
    }
    this.output.write("\n(^C again to exit, or /exit)\n");
    this.rl.prompt();
  }

  /** Write above the prompt line without leaving a half-drawn prompt behind. */
  clearLine(): void {
    if (this.tty) this.output.write("\r\x1b[K");
  }

  close(): void {
    if (this.closed) return;
    process.off("SIGINT", this.onProcessSigint);
    this.rl.close();
    this.closed = true;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private complete(line: string): [string[], string] {
    if (!this.completion) return [[], line];
    const cmd = /^(\/[a-zA-Z][\w-]*)\s+(\S*)$/.exec(line);
    if (cmd) {
      const [, name = "", partial = ""] = cmd;
      const hits = this.completion.argsFor(name).filter((c) => c.startsWith(partial));
      return [hits, partial];
    }
    if (!line.startsWith("/")) return [[], line];
    const hits = this.completion.commands().filter((c) => c.startsWith(line));
    return [hits, line];
  }
}
