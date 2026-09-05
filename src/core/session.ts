import { appendFile, mkdir, readdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Block, Turn } from "../model/ir.ts";

/**
 * Session state (LAYERS.md: Context & Memory).
 *
 * **Append-only**, deliberately. Editing an earlier turn invalidates every cache breakpoint
 * after it and breaks reasoning-block replay — both failures are silent and expensive, so the
 * data structure forbids the edit rather than documenting against it.
 */
export interface SessionRecord {
  seq: number;
  at: string;
  turn: Turn;
  pass: string;
}

/** One resumable conversation on disk. Sub-agent forks are excluded — see `Session.list`. */
export interface SessionInfo {
  id: string;
  path: string;
  turns: number;
  at: Date;
}

export class Session {
  readonly id: string;
  readonly path: string;
  private turns: Turn[] = [];
  private seq = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(id: string, root: string) {
    this.id = id;
    this.path = join(root, ".kalee", "sessions", `${id}.jsonl`);
  }

  append(turn: Turn, pass = "main"): void {
    this.turns.push(turn);
    const rec: SessionRecord = { seq: this.seq++, at: new Date().toISOString(), turn, pass };
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, JSON.stringify(rec) + "\n", "utf8");
    });
  }

  user(blocks: Block[], pass?: string): void {
    this.append({ role: "user", blocks }, pass);
  }

  assistant(blocks: Block[], pass?: string): void {
    this.append({ role: "assistant", blocks }, pass);
  }

  /**
   * The transcript as the model sees it, as a snapshot. Handing out the live array would let
   * a caller holding a `Request` watch it grow underneath them, which is a confusing class of
   * bug to chase for no benefit.
   */
  transcript(): Turn[] {
    return [...this.turns];
  }

  flush(): Promise<void> {
    return this.queue;
  }

  /**
   * A child session for a sub-agent: fresh context, shared trace id. This is the handoff
   * boundary — the verify pass must not inherit the scan pass's reasoning, or it just agrees
   * with itself.
   */
  fork(pass: string): Session {
    const child = new Session(`${this.id}.${pass}`, dirname(dirname(dirname(this.path))));
    return child;
  }

  /**
   * Prime a session with turns it did not produce — how compaction hands a summarized
   * transcript to its replacement session. These *are* appended, because the replacement's
   * file is a new record, not a copy of the old one.
   */
  seed(turns: Turn[], pass = "seed"): void {
    for (const t of turns) this.append(t, pass);
  }

  /**
   * Reopen an existing conversation for another run. Turns are replayed into memory but not
   * re-appended: the file already holds them, and writing them twice would double the
   * transcript the model sees on the run after that.
   */
  static async resume(id: string, root: string): Promise<Session> {
    const s = new Session(id, root);
    const records = await Session.read(s.path);
    s.turns = records.map((r) => r.turn);
    s.seq = records.reduce((max, r) => Math.max(max, r.seq + 1), 0);
    return s;
  }

  /** Resumable conversations under `root`, newest first. */
  static async list(root: string): Promise<SessionInfo[]> {
    const dir = join(root, ".kalee", "sessions");
    if (!existsSync(dir)) return [];
    const out: SessionInfo[] = [];
    for (const name of await readdir(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const id = name.slice(0, -".jsonl".length);
      // `fork` names a sub-agent session `<id>.<pass>`. Those are handoff scratch space, not
      // conversations anyone would want to resume.
      if (id.includes(".")) continue;
      const path = join(dir, name);
      const [st, raw] = await Promise.all([stat(path), readFile(path, "utf8")]);
      out.push({ id, path, turns: raw.split("\n").filter(Boolean).length, at: st.mtime });
    }
    return out.sort((a, b) => b.at.getTime() - a.at.getTime());
  }

  static async read(path: string): Promise<SessionRecord[]> {
    if (!existsSync(path)) throw new Error(`no such session: ${path}`);
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SessionRecord);
  }
}
