import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandNames, findCommand, parse, parseReviewArgs } from "../src/repl/commands.ts";
import { LineReader } from "../src/repl/input.ts";
import { specFrom } from "../src/review/target.ts";
import { StreamRenderer, tokenize, wrapRuns } from "../src/repl/render.ts";
import { Session } from "../src/core/session.ts";
import { renderTranscript, summarizeTranscript } from "../src/core/compact.ts";
import { wrap } from "../src/core/text.ts";
import type { Turn } from "../src/model/ir.ts";
import { DEFAULT_CAPS, type Capabilities, type ModelProvider, type Pricing } from "../src/model/provider.ts";
import type { Event, Request } from "../src/model/ir.ts";

describe("input parsing", () => {
  test("routes commands, shell escapes and prose", () => {
    expect(parse("/model opus-5")).toEqual({ kind: "command", name: "model", args: "opus-5" });
    expect(parse("/help")).toEqual({ kind: "command", name: "help", args: "" });
    expect(parse("!git log --oneline")).toEqual({ kind: "shell", command: "git log --oneline" });
    expect(parse("why is store.ts:142 wrong?")).toEqual({
      kind: "prompt",
      text: "why is store.ts:142 wrong?",
    });
    expect(parse("   ")).toEqual({ kind: "empty" });
    expect(parse("!")).toEqual({ kind: "empty" });
  });

  test("a path is a question, not a command", () => {
    // `/word` is only a command when the next character ends the word. Otherwise every
    // absolute path the user pastes becomes an 'unknown command'.
    expect(parse("/Users/me/notes.md").kind).toBe("prompt");
    expect(parse("/src/auth explain this").kind).toBe("prompt");
    expect(parse("/review src/auth/")).toEqual({
      kind: "command",
      name: "review",
      args: "src/auth/",
    });
  });

  test("an unknown slash command stays a command, so it can be reported", () => {
    const parsed = parse("/nope");
    expect(parsed.kind).toBe("command");
    expect(findCommand("nope")).toBeUndefined();
  });

  test("aliases resolve and every advertised name is findable", () => {
    expect(findCommand("q")).toBe(findCommand("exit")!);
    for (const name of commandNames()) {
      expect(findCommand(name.slice(1))).toBeDefined();
    }
  });
});

describe("stream rendering", () => {
  const render = (chunks: string[]): string => {
    let out = "";
    const r = new StreamRenderer((s) => (out += s), 60);
    for (const c of chunks) r.push(c);
    r.flush();
    return out;
  };

  test("reassembles markup split across deltas", () => {
    // The whole reason for buffering to a newline: a token boundary must not leak `**` into
    // the terminal, exactly as the tool-call shim must not leak a half-written tag.
    const split = render(["it is **bro", "ken** here\n"]);
    const whole = render(["it is **broken** here\n"]);
    expect(split).toBe(whole);
    expect(split).not.toContain("**");
    expect(split).toContain("broken");
  });

  test("leaves code inside a fence unwrapped and unstyled", () => {
    const long = "const x = " + "y".repeat(80) + ";";
    const out = render(["```ts\n", `${long}\n`, "```\n"]);
    expect(out).toContain(long); // one piece, not folded mid-identifier
    expect(out).not.toContain("```");
  });

  test("stays usable after a flush, so a tool call can interrupt the prose", () => {
    let out = "";
    const r = new StreamRenderer((s) => (out += s), 60);
    r.push("before");
    r.flush();
    expect(r.dirty).toBe(true);
    r.push(" after\n");
    r.flush();
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  test("wraps by visible width, not by escape-sequence length", () => {
    const runs = tokenize("plain **bold** more words here to force a wrap eventually yes");
    const wrapped = wrapRuns(runs, 20, "  ");
    const widest = Math.max(
      // eslint-disable-next-line no-control-regex
      ...wrapped.split("\n").map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimStart().length),
    );
    expect(widest).toBeLessThanOrEqual(20);
  });
});

describe("wrap", () => {
  test("indents continuation lines only", () => {
    const out = wrap("one two three four five", 9, "..");
    expect(out.split("\n")[0]).toBe("one two");
    expect(out.split("\n")[1]).toStartWith("..");
  });
});

describe("session persistence", () => {
  const withRepo = async (fn: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(join(tmpdir(), "kalee-repl-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  test("resume replays the transcript without duplicating it on disk", async () => {
    await withRepo(async (dir) => {
      const first = new Session("s1", dir);
      first.user([{ type: "text", text: "hello" }]);
      first.assistant([{ type: "text", text: "hi" }]);
      await first.flush();

      const again = await Session.resume("s1", dir);
      expect(again.transcript()).toEqual(first.transcript());

      // The append continues the sequence rather than restarting it, and the file gains
      // exactly one line — resume must not rewrite what is already recorded.
      again.user([{ type: "text", text: "more" }]);
      await again.flush();
      const records = await Session.read(again.path);
      expect(records).toHaveLength(3);
      expect(records.map((r) => r.seq)).toEqual([0, 1, 2]);
    });
  });

  test("list ranks conversations newest first and hides sub-agent forks", async () => {
    await withRepo(async (dir) => {
      const older = new Session("aaa", dir);
      older.user([{ type: "text", text: "x" }]);
      await older.flush();
      await Bun.sleep(10);
      const newer = new Session("bbb", dir);
      newer.user([{ type: "text", text: "y" }]);
      await newer.flush();
      // A verify pass writes `bbb.verify1.jsonl`; that is handoff scratch, not a conversation.
      const fork = newer.fork("verify1");
      fork.user([{ type: "text", text: "z" }]);
      await fork.flush();

      const list = await Session.list(dir);
      expect(list.map((s) => s.id)).toEqual(["bbb", "aaa"]);
      expect(list[0]!.turns).toBe(1);
    });
  });
});

describe("conversation compaction", () => {
  class SummarizingProvider implements ModelProvider {
    readonly id = "summarizer";
    readonly kind = "script";
    readonly apiModel = "script";
    readonly pricing: Pricing = { input: 0, output: 0 };
    readonly caps: Capabilities = { ...DEFAULT_CAPS, maxContext: 8000 };
    seen: Request[] = [];
    async *stream(req: Request): AsyncIterable<Event> {
      this.seen.push(req);
      yield { type: "text_delta", text: "Goal: fix the pager. Established: store.ts:142 is off by one." };
      yield { type: "turn_end", stop: "end_turn", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
    }
    async countTokens(): Promise<number> {
      return 100;
    }
  }

  const chat = (role: "user" | "assistant", text: string): Turn => ({
    role,
    blocks: [{ type: "text", text }],
  });

  test("replaces the old turns with one summary and keeps the recent ones verbatim", async () => {
    const turns: Turn[] = [
      chat("user", "q1"),
      chat("assistant", "a1"),
      chat("user", "q2"),
      chat("assistant", "a2"),
      chat("user", "q3"),
      chat("assistant", "a3"),
    ];
    const provider = new SummarizingProvider();
    const out = await summarizeTranscript(provider, turns, { keepLast: 2 });

    expect(out.dropped).toBe(4);
    expect(out.turns).toHaveLength(3);
    expect(out.turns[0]!.role).toBe("user");
    expect(out.turns[0]!.blocks[0]).toMatchObject({ type: "text" });
    expect(out.turns.at(-1)).toEqual(chat("assistant", "a3"));
  });

  test("never cuts between a tool call and its result", async () => {
    const turns: Turn[] = [
      chat("user", "q1"),
      { role: "assistant", blocks: [{ type: "tool_call", id: "1", name: "read_file", input: {} }] },
      { role: "user", blocks: [{ type: "tool_result", id: "1", isError: false, content: [{ type: "text", text: "file" }] }] },
      chat("assistant", "a1"),
    ];
    // Asking to keep the last two would start the window at the tool_result turn, orphaning it
    // from the call that produced it — which every provider rejects on replay.
    const out = await summarizeTranscript(new SummarizingProvider(), turns, { keepLast: 2 });
    for (const t of out.turns) {
      if (t.role === "user" && t.blocks.some((b) => b.type === "tool_result")) {
        throw new Error("kept an orphaned tool_result");
      }
    }
    expect(out.dropped).toBe(4);
  });

  test("renders tool traffic into the transcript it summarizes", () => {
    const text = renderTranscript([
      { role: "assistant", blocks: [{ type: "tool_call", id: "1", name: "grep", input: { pattern: "auth" } }] },
      { role: "user", blocks: [{ type: "tool_result", id: "1", isError: false, content: [{ type: "text", text: "3 hits" }] }] },
    ]);
    expect(text).toContain("grep");
    expect(text).toContain("3 hits");
  });
});

describe("/review arguments", () => {
  test("maps flags onto the same target spec the one-shot command uses", () => {
    expect(specFrom(parseReviewArgs([]).target, parseReviewArgs([]))).toEqual({ kind: "working-tree" });
    expect(specFrom(parseReviewArgs(["--staged"]).target, parseReviewArgs(["--staged"]))).toEqual({
      kind: "staged",
    });

    const ranged = parseReviewArgs(["--base", "main"]);
    expect(specFrom(ranged.target, ranged)).toEqual({ kind: "range", base: "main" });

    const pr = parseReviewArgs(["1234", "--repo", "o/r"]);
    expect(specFrom(pr.target, pr)).toEqual({ kind: "pr", number: 1234, repo: "o/r" });

    const path = parseReviewArgs(["src/auth/"]);
    expect(specFrom(path.target, path)).toEqual({ kind: "path", path: "src/auth/" });
  });

  test("--base consumes its value rather than leaving it as the target", () => {
    // The bug this guards: `main` falling through to the bare-word branch and being reviewed
    // as a path called `main`.
    expect(parseReviewArgs(["--base", "main"])).toEqual({
      staged: false,
      verify: true,
      base: "main",
    });
    expect(parseReviewArgs(["--base", "main", "--no-verify"]).verify).toBe(false);
  });

  test("ignores unknown flags instead of reviewing them as a path", () => {
    expect(parseReviewArgs(["--oops"]).target).toBeUndefined();
    expect(parseReviewArgs(["--oops", "src/a.ts"]).target).toBe("src/a.ts");
  });

  test("keeps the first bare word when several are given", () => {
    expect(parseReviewArgs(["src/a.ts", "src/b.ts"]).target).toBe("src/a.ts");
  });
});

describe("interrupt wiring", () => {
  /**
   * The handler is invoked directly rather than by emitting SIGINT: raising a real signal in a
   * test run would reach the test runner's own handler too.
   */
  const added = (before: readonly unknown[]) =>
    process.listeners("SIGINT").filter((l) => !before.includes(l));

  test("a running turn owns Ctrl-C, and hands it back when the turn ends", () => {
    const before = process.listeners("SIGINT").slice();
    const reader = new LineReader();
    try {
      let interrupts = 0;
      reader.beginTurn(() => interrupts++);

      const handlers = added(before);
      expect(handlers).toHaveLength(1);
      (handlers[0] as () => void)();
      expect(interrupts).toBe(1);

      reader.endTurn();
      // Left installed, the handler would swallow the Ctrl-C that should be exiting the REPL.
      expect(added(before)).toHaveLength(0);
    } finally {
      reader.close();
    }
  });

  test("repeated turns do not accumulate handlers", () => {
    const before = process.listeners("SIGINT").slice();
    const reader = new LineReader();
    try {
      for (let i = 0; i < 3; i++) {
        reader.beginTurn(() => {});
        expect(added(before)).toHaveLength(1);
        reader.endTurn();
      }
      expect(added(before)).toHaveLength(0);
    } finally {
      reader.close();
    }
  });

  test("closing releases the handler even mid-turn", () => {
    const before = process.listeners("SIGINT").slice();
    const reader = new LineReader();
    reader.beginTurn(() => {});
    reader.close();
    expect(added(before)).toHaveLength(0);
  });
});
