import { appendFile, mkdir, readFile } from "node:fs/promises";
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

  static async read(path: string): Promise<SessionRecord[]> {
    if (!existsSync(path)) throw new Error(`no such session: ${path}`);
    const raw = await readFile(path, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as SessionRecord);
  }
}
