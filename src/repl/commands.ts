import type { Effort } from "../model/ir.ts";
import type { PermissionMode } from "../core/policy.ts";

/**
 * Slash commands.
 *
 * `parse` is pure and the table is data, so both are testable without a terminal — the REPL
 * driver supplies the behaviour through `ReplContext`.
 */
export type Parsed =
  | { kind: "empty" }
  | { kind: "command"; name: string; args: string }
  | { kind: "shell"; command: string }
  | { kind: "prompt"; text: string };

// A command is `/word` followed by end-of-line or a space. `/Users/me/notes.md` is a path and
// falls through to the model, because the character after `Users` is a slash, not a space.
const COMMAND = /^\/([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/;

export function parse(line: string): Parsed {
  const text = line.trim();
  if (!text) return { kind: "empty" };
  if (text.startsWith("!")) {
    const command = text.slice(1).trim();
    return command ? { kind: "shell", command } : { kind: "empty" };
  }
  const m = COMMAND.exec(text);
  if (m) return { kind: "command", name: (m[1] ?? "").toLowerCase(), args: (m[2] ?? "").trim() };
  return { kind: "prompt", text };
}

/** Split an argument string the way a shell would, minus quoting subtleties we do not need. */
export function argv(args: string): string[] {
  return args.split(/\s+/).filter(Boolean);
}

export interface ReviewArgs {
  target?: string;
  base?: string;
  staged: boolean;
  repo?: string;
  /** False when `--no-verify` was passed. */
  verify: boolean;
}

/**
 * `/review`'s arguments. Deliberately a pure function rather than inline in the driver: this is
 * the command people actually type flags at, and `--base` swallowing the next token is exactly
 * the kind of thing that breaks silently.
 */
export function parseReviewArgs(args: string[]): ReviewArgs {
  const out: ReviewArgs = { staged: false, verify: true };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case "--base":
        out.base = args[++i];
        break;
      case "--staged":
        out.staged = true;
        break;
      case "--no-verify":
        out.verify = false;
        break;
      case "--repo":
        out.repo = args[++i];
        break;
      default:
        // The first bare word is the target; an unknown flag is ignored rather than treated as
        // one, or `/review --oops` would try to review a path called `--oops`.
        if (!a.startsWith("-")) out.target ??= a;
    }
  }
  return out;
}

/** What a command may do to the session. Implemented by the REPL driver. */
export interface ReplContext {
  say(message: string): void;
  cwd: string;
  setModel(id: string): Promise<void>;
  setEffort(effort: Effort): void;
  setPermissionMode(mode: PermissionMode): void;
  listModels(): Promise<string>;
  runReview(args: string[]): Promise<void>;
  cost(): string;
  listTools(): string;
  listSkills(): Promise<string>;
  loadSkill(name: string): Promise<void>;
  clear(): Promise<void>;
  compact(): Promise<void>;
  tracePath(): string;
  listSessions(): Promise<string>;
  resumeSession(id: string): Promise<void>;
}

export interface ReplCommand {
  name: string;
  aliases?: string[];
  /** Argument spec, for `/help`. */
  usage?: string;
  summary: string;
  run(ctx: ReplContext, args: string): Promise<"exit" | void>;
}

const EFFORTS: Effort[] = ["low", "medium", "high", "max"];
const MODES: PermissionMode[] = ["readonly", "ask", "auto", "deny"];

export const COMMANDS: ReplCommand[] = [
  {
    name: "help",
    aliases: ["?"],
    summary: "List the commands",
    async run(ctx) {
      ctx.say(helpText());
    },
  },
  {
    name: "exit",
    aliases: ["quit", "q"],
    summary: "Leave the session",
    async run() {
      return "exit";
    },
  },
  {
    name: "model",
    usage: "[id]",
    summary: "Show the registry, or switch model for this session",
    async run(ctx, args) {
      if (!args) {
        ctx.say(await ctx.listModels());
        return;
      }
      await ctx.setModel(args.trim());
    },
  },
  {
    name: "effort",
    usage: `<${EFFORTS.join("|")}>`,
    summary: "Set reasoning effort",
    async run(ctx, args) {
      const level = args.trim() as Effort;
      if (!EFFORTS.includes(level)) {
        ctx.say(`usage: /effort ${EFFORTS.join("|")}`);
        return;
      }
      ctx.setEffort(level);
    },
  },
  {
    name: "permission",
    usage: `<${MODES.join("|")}>`,
    summary: "Change what tools are allowed",
    async run(ctx, args) {
      const mode = args.trim() as PermissionMode;
      if (!MODES.includes(mode)) {
        ctx.say(`usage: /permission ${MODES.join("|")}`);
        return;
      }
      ctx.setPermissionMode(mode);
    },
  },
  {
    name: "review",
    usage: "[target] [--base <ref>] [--staged] [--no-verify]",
    summary: "Run the scan→verify pipeline and keep the findings in context",
    async run(ctx, args) {
      await ctx.runReview(argv(args));
    },
  },
  {
    name: "cost",
    summary: "Tokens and spend so far",
    async run(ctx) {
      ctx.say(ctx.cost());
    },
  },
  {
    name: "tools",
    summary: "List the tools and their effects",
    async run(ctx) {
      ctx.say(ctx.listTools());
    },
  },
  {
    name: "skills",
    summary: "List the available skills",
    async run(ctx) {
      ctx.say(await ctx.listSkills());
    },
  },
  {
    name: "skill",
    usage: "<name>",
    summary: "Load a skill's body into context",
    async run(ctx, args) {
      if (!args) {
        ctx.say("usage: /skill <name>");
        return;
      }
      await ctx.loadSkill(args.trim());
    },
  },
  {
    name: "clear",
    summary: "Start a fresh conversation",
    async run(ctx) {
      await ctx.clear();
    },
  },
  {
    name: "compact",
    summary: "Summarize the conversation so far and continue in a smaller context",
    async run(ctx) {
      await ctx.compact();
    },
  },
  {
    name: "trace",
    summary: "Where this run's trace is being written",
    async run(ctx) {
      ctx.say(ctx.tracePath());
    },
  },
  {
    name: "sessions",
    summary: "List resumable sessions in this repository",
    async run(ctx) {
      ctx.say(await ctx.listSessions());
    },
  },
  {
    name: "resume",
    usage: "<id>",
    summary: "Continue a previous session",
    async run(ctx, args) {
      if (!args) {
        ctx.say("usage: /resume <id> — see /sessions");
        return;
      }
      await ctx.resumeSession(args.trim());
    },
  },
];

export function findCommand(name: string): ReplCommand | undefined {
  return COMMANDS.find((c) => c.name === name || c.aliases?.includes(name));
}

/** Every name a user can type, for tab completion. */
export function commandNames(): string[] {
  return COMMANDS.flatMap((c) => [c.name, ...(c.aliases ?? [])]).map((n) => `/${n}`);
}

export function helpText(): string {
  const rows = COMMANDS.map((c) => {
    const left = `/${c.name}${c.usage ? ` ${c.usage}` : ""}`;
    return { left, right: c.summary };
  });
  const width = Math.max(...rows.map((r) => r.left.length));
  const lines = rows.map((r) => `  ${r.left.padEnd(width)}  ${r.right}`);
  return [
    "",
    ...lines,
    `  ${"!<command>".padEnd(width)}  Run a shell command and keep the output in context`,
    "",
    "  Ctrl-C interrupts a running turn · Ctrl-D exits",
  ].join("\n");
}
