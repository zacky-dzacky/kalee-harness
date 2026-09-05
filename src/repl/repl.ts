import pc from "picocolors";
import { homedir } from "node:os";
import { ProviderError, type CacheSpan, type Effort } from "../model/ir.ts";
import { loadRegistry, resolveRole, type Registry, type Role } from "../model/registry.ts";
import { makeProvider } from "../providers/index.ts";
import type { ModelProvider } from "../model/provider.ts";
import { ContextBuilder, repoMap } from "../core/context.ts";
import { loadOverlay, loadPrompt } from "../core/identity.ts";
import { limitsFrom, loadConfig, type Config } from "../core/config.ts";
import { runLoop } from "../core/loop.ts";
import { Policy, type PermissionMode } from "../core/policy.ts";
import { Session } from "../core/session.ts";
import { newId, Trace } from "../core/trace.ts";
import { loadSkills, manifest, type Skill } from "../core/skills.ts";
import { crudeTokens, estimateFit, summarizeTranscript } from "../core/compact.ts";
import { terminalWidth } from "../core/text.ts";
import { defaultRegistry, ToolRegistry } from "../tools/index.ts";
import { bashTool } from "../tools/bash.ts";
import { exec } from "../tools/exec.ts";
import { resolveTarget, specFrom } from "../review/target.ts";
import { review, type ReviewResult } from "../review/pipeline.ts";
import { renderTerminal } from "../review/render/terminal.ts";
import { LineReader } from "./input.ts";
import { banner, statusLine, StreamRenderer, toolLine } from "./render.ts";
import { commandNames, findCommand, parse, parseReviewArgs, type ReplContext } from "./commands.ts";

/**
 * The interactive session (LAYERS.md: Orchestration & lifecycle, at the human end).
 *
 * What distinguishes this from `kalee ask` in a shell loop is that one `Session`, one `Trace`
 * and one cached system prefix span every turn: the follow-up question is the point, and it is
 * only cheap if the prefix survives.
 */
export interface ReplOptions {
  cwd: string;
  model?: string;
  roleModels?: Partial<Record<Role, string>>;
  effort?: Effort;
  permissionMode?: PermissionMode;
  /** Resume this session id. */
  resume?: string;
  /** Resume the most recent session in the repository. */
  continueLatest?: boolean;
  maxCost?: number;
}

/** Compact above this share of the model's context window. */
const COMPACT_AT = 0.7;

export async function startRepl(opts: ReplOptions): Promise<void> {
  const repl = await Repl.create(opts);
  await repl.run();
}

class Repl implements ReplContext {
  readonly cwd: string;
  private reg: Registry;
  private config: Config;
  private provider: ModelProvider;
  private session: Session;
  private trace: Trace;
  private policy!: Policy;
  private reader: LineReader;
  private skills: Map<string, Skill>;
  private loadedSkills = new Set<string>();
  private system: CacheSpan[] = [];
  private effort: Effort;
  private mode: PermissionMode;
  private overrides: { model?: string; roleModels?: Partial<Record<Role, string>> };
  private maxCost?: number;
  /**
   * Context produced outside a turn — a review's findings, a shell command's output — waiting to
   * ride along with the user's next message. Prepending beats injecting a turn of its own: a
   * synthetic assistant reply to keep the roles alternating would be a lie in the transcript,
   * and if the user never follows up, nothing was spent.
   */
  private pending: string[] = [];
  private branch: string | null = null;
  private readonly startedAt = Date.now();

  private constructor(init: {
    cwd: string;
    reg: Registry;
    config: Config;
    provider: ModelProvider;
    session: Session;
    trace: Trace;
    skills: Map<string, Skill>;
    effort: Effort;
    mode: PermissionMode;
    overrides: { model?: string; roleModels?: Partial<Record<Role, string>> };
    maxCost?: number;
  }) {
    this.cwd = init.cwd;
    this.reg = init.reg;
    this.config = init.config;
    this.provider = init.provider;
    this.session = init.session;
    this.trace = init.trace;
    this.skills = init.skills;
    this.effort = init.effort;
    this.mode = init.mode;
    this.overrides = init.overrides;
    this.maxCost = init.maxCost;
    this.reader = new LineReader({
      completion: {
        commands: () => commandNames(),
        argsFor: (name) => this.completionsFor(name),
      },
    });
    this.applyPermissionMode(init.mode);
  }

  static async create(opts: ReplOptions): Promise<Repl> {
    const { cwd } = opts;
    const config = await loadConfig(cwd);
    const reg = await loadRegistry(cwd);
    const overrides = {
      model: opts.model ?? config.model,
      roleModels: { ...config.roleModels, ...opts.roleModels },
    };
    const provider = makeProvider(resolveRole(reg, "default", overrides));

    const id = newId();
    const trace = new Trace(id, cwd);
    trace.write({ t: "run_start", at: new Date().toISOString(), command: "repl", cwd });

    const session = await openSession(opts, cwd, id);

    const repl = new Repl({
      cwd,
      reg,
      config,
      provider,
      session,
      trace,
      skills: await loadSkills(cwd),
      effort: opts.effort ?? config.effort ?? "medium",
      // `ask` rather than `readonly`: read-only tools stay automatic, and the one tool that is
      // not — bash — becomes a question instead of a refusal.
      mode: opts.permissionMode ?? config.permissionMode ?? "ask",
      overrides,
      maxCost: opts.maxCost,
    });
    repl.system = await repl.buildSystem();
    repl.branch = await gitBranch(cwd);
    return repl;
  }

  // -------------------------------------------------------------------------
  // The loop
  // -------------------------------------------------------------------------

  async run(): Promise<void> {
    await this.reader.loadHistory();
    process.stdout.write(banner(this.provider.id, this.cwd, this.branch, homedir()));
    const resumed = this.session.transcript().length;
    if (resumed > 0) {
      this.say(pc.dim(`resumed ${this.session.id} · ${plural(resumed, "turn")}`));
    }
    this.say(pc.dim("/help for commands, Ctrl-D to exit"));

    try {
      for (;;) {
        const line = await this.reader.prompt("\n› ");
        if (line === null) break;
        const parsed = parse(line);
        if (parsed.kind === "empty") continue;

        try {
          if (parsed.kind === "prompt") {
            await this.turn(parsed.text);
          } else if (parsed.kind === "shell") {
            await this.shell(parsed.command);
          } else {
            const cmd = findCommand(parsed.name);
            if (!cmd) {
              this.say(pc.yellow(`unknown command /${parsed.name}`) + pc.dim(" — /help"));
              continue;
            }
            if ((await cmd.run(this, parsed.args)) === "exit") break;
          }
        } catch (e) {
          this.reportError(e);
        }
      }
    } finally {
      this.reader.close();
      await this.session.flush();
      await this.trace.finish();
      process.stdout.write(
        `\n${statusLine(this.provider.id, this.trace.usage(), this.trace.costUsd(), Date.now() - this.startedAt)}\n` +
          pc.dim(`  session ${this.session.id} · resume with \`kalee --continue\`\n`),
      );
    }
  }

  private async turn(text: string): Promise<void> {
    const message = this.pending.length ? [...this.pending, text].join("\n\n") : text;
    this.pending = [];
    this.session.user([{ type: "text", text: message }]);
    await this.runTurn();
  }

  private async runTurn(): Promise<void> {
    await this.maybeCompact();

    const ctl = new AbortController();
    const stream = new StreamRenderer((s) => process.stdout.write(s), terminalWidth() - 2);
    const started = Date.now();
    const before = { ...this.trace.usage() };
    const costBefore = this.trace.costUsd();

    process.stdout.write("\n");
    try {
      this.reader.beginTurn(() => ctl.abort());
      const result = await runLoop({
        provider: this.provider,
        tools: this.tools(),
        system: this.system,
        session: this.session,
        trace: this.trace,
        policy: this.policy,
        cwd: this.cwd,
        pass: "chat",
        effort: this.effort,
        limits: this.limits(),
        signal: ctl.signal,
        onText: (t) => stream.push(t),
        onTool: (e) => {
          // Finish the sentence the model was mid-way through before the tool line lands, or
          // the two interleave on the same row.
          stream.flush();
          process.stdout.write(`${toolLine(e)}\n`);
        },
      });
      stream.flush();
      if (result.haltReason === "interrupted") {
        this.say(pc.yellow("interrupted"));
      } else if (result.haltReason) {
        this.say(pc.yellow(`halted: ${result.haltReason}`));
      }
    } finally {
      this.reader.endTurn();
      await this.session.flush();
    }

    const usage = this.trace.usage();
    const delta = {
      input: usage.input - before.input,
      output: usage.output - before.output,
      cacheRead: usage.cacheRead - before.cacheRead,
      cacheWrite: usage.cacheWrite - before.cacheWrite,
    };
    process.stdout.write(
      `\n${statusLine(this.provider.id, delta, this.trace.costUsd() - costBefore, Date.now() - started)}\n`,
    );
  }

  /**
   * `report_finding` is withheld: it emits into the review pipeline's collector, which does not
   * exist here, so a finding reported in chat would vanish silently.
   */
  private tools(): ToolRegistry {
    return new ToolRegistry(defaultRegistry().list().filter((t) => t.name !== "report_finding"));
  }

  /**
   * `runLoop` builds a fresh `Budget` per call, which is what makes per-message turn and
   * wall-clock caps correct. A spend cap for the *session* is not per-message, so it is tracked
   * against the trace — the only thing that accumulates across turns — and handed down as
   * whatever is left.
   */
  private limits() {
    const base = limitsFrom(this.config);
    if (this.maxCost === undefined) return base;
    return { ...base, maxCostUsd: Math.max(0, this.maxCost - this.trace.costUsd()) };
  }

  private async buildSystem(): Promise<CacheSpan[]> {
    const b = new ContextBuilder()
      .identity(await loadPrompt("repl"))
      .overlay(await loadOverlay(this.cwd));
    for (const name of this.loadedSkills) {
      const skill = this.skills.get(name);
      if (skill) b.skill(skill);
    }
    b.addStable(manifest(this.skills.values()));
    b.addStable(await repoMap(this.cwd));
    return b.build();
  }

  // -------------------------------------------------------------------------
  // Compaction
  // -------------------------------------------------------------------------

  private async maybeCompact(): Promise<void> {
    const turns = this.session.transcript();
    if (turns.length < 6) return;
    // The crude estimate is free; `countTokens` is a round trip on every backend that has it.
    // Only pay for the accurate number once the cheap one says we are anywhere near the edge.
    if (crudeTokens(this.system, turns) < this.provider.caps.maxContext * 0.5) return;
    const fit = await estimateFit(this.provider, this.system, turns);
    if (fit.fraction < COMPACT_AT) return;
    this.say(
      pc.yellow(
        `context ${(fit.fraction * 100).toFixed(0)}% of ${fit.limit.toLocaleString()} — compacting`,
      ),
    );
    await this.compact();
  }

  async compact(): Promise<void> {
    const turns = this.session.transcript();
    if (turns.length === 0) {
      this.say(pc.dim("nothing to compact"));
      return;
    }
    const result = await summarizeTranscript(this.provider, turns);
    if (result.dropped === 0) {
      this.say(pc.dim("nothing old enough to compact"));
      return;
    }
    // The session is append-only by design, so compaction is a new one seeded with the summary
    // rather than an edit of the old — which also leaves the full transcript on disk.
    await this.session.flush();
    const next = new Session(newId(), this.cwd);
    next.seed(result.turns);
    // Land it before anything can look for it — `/sessions` right after `/compact` would
    // otherwise list the conversation this one just replaced.
    await next.flush();
    this.trace.note("chat", `compacted ${result.dropped} turns`, { from: this.session.id, to: next.id });
    this.session = next;
    this.say(pc.dim(`summarized ${result.dropped} turns → 1 · now ${next.id}`));
  }

  // -------------------------------------------------------------------------
  // ReplContext
  // -------------------------------------------------------------------------

  say(message: string): void {
    process.stdout.write(`${message}\n`);
  }

  async setModel(id: string): Promise<void> {
    this.overrides.model = id;
    this.provider = makeProvider(resolveRole(this.reg, "default", { model: id }));
    this.say(pc.dim(`model → ${this.provider.id} (${this.provider.kind})`));
  }

  setEffort(effort: Effort): void {
    this.effort = effort;
    this.say(pc.dim(`effort → ${effort}`));
  }

  setPermissionMode(mode: PermissionMode): void {
    this.applyPermissionMode(mode);
    this.say(pc.dim(`permissions → ${mode}`));
  }

  private applyPermissionMode(mode: PermissionMode): void {
    this.mode = mode;
    this.policy = new Policy({
      mode,
      allow: this.config.allow,
      deny: this.config.deny,
      confirm: (tool, effect, input) =>
        this.reader.confirm(
          `\n${pc.yellow("permission")} ${pc.bold(tool)} ${pc.dim(`(${effect})`)} ` +
            `${pc.dim(JSON.stringify(input).slice(0, 160))}\nallow? [y/N] `,
        ),
    });
  }

  async listModels(): Promise<string> {
    const lines = this.reg.models.map((m) => {
      const here = m.id === this.provider.id ? pc.green(" ←") : "";
      return `  ${pc.bold(m.id.padEnd(16))} ${pc.dim(`${m.provider} · ${m.apiModel}`)}${here}`;
    });
    return ["", ...lines, "", pc.dim("  /model <id> to switch")].join("\n");
  }

  cost(): string {
    const u = this.trace.usage();
    return (
      `\n${statusLine(this.provider.id, u, this.trace.costUsd())}\n` +
      pc.dim(`  ${plural(this.session.transcript().length, "turn")} · effort ${this.effort} · ${this.mode}`)
    );
  }

  listTools(): string {
    const lines = this.tools()
      .list()
      .map((t) => {
        const gate = t.effect === "read-only" ? pc.green(t.effect) : pc.yellow(t.effect);
        return `  ${pc.bold(t.name.padEnd(12))} ${gate}`;
      });
    return ["", ...lines, "", pc.dim(`  permission mode: ${this.mode}`)].join("\n");
  }

  async listSkills(): Promise<string> {
    if (this.skills.size === 0) return pc.dim("no skills found");
    const lines = [...this.skills.values()].map((s) => {
      const on = this.loadedSkills.has(s.name) ? pc.green(" [loaded]") : "";
      return `  ${pc.bold(s.name)}${on}\n    ${pc.dim(s.description)}`;
    });
    return ["", ...lines, "", pc.dim("  /skill <name> to load one")].join("\n");
  }

  async loadSkill(name: string): Promise<void> {
    const skill = this.skills.get(name);
    if (!skill) {
      const known = [...this.skills.keys()].join(", ") || "none found";
      this.say(pc.yellow(`unknown skill \`${name}\``) + pc.dim(` — available: ${known}`));
      return;
    }
    if (this.loadedSkills.has(name)) {
      this.say(pc.dim(`${name} is already loaded`));
      return;
    }
    this.loadedSkills.add(name);
    this.system = await this.buildSystem();
    // Worth saying out loud: the skill body goes into the cached prefix, so the next turn pays
    // full price for the tokens before it starts hitting again.
    this.say(pc.dim(`loaded skill ${name} — the next turn re-primes the prompt cache`));
  }

  async clear(): Promise<void> {
    await this.session.flush();
    this.session = new Session(newId(), this.cwd);
    this.pending = [];
    this.say(pc.dim(`new session ${this.session.id}`));
  }

  tracePath(): string {
    return pc.dim(`  ${this.trace.path}\n  kalee trace ${this.trace.id}`);
  }

  async listSessions(): Promise<string> {
    const list = await Session.list(this.cwd);
    if (list.length === 0) return pc.dim("no sessions yet");
    const rows = list.slice(0, 15).map((s) => {
      const here = s.id === this.session.id ? pc.green(" ←") : "";
      return `  ${pc.bold(s.id)}  ${pc.dim(`${plural(s.turns, "turn")} · ${ago(s.at)}`)}${here}`;
    });
    return ["", ...rows, "", pc.dim("  /resume <id>")].join("\n");
  }

  async resumeSession(id: string): Promise<void> {
    await this.session.flush();
    this.session = await Session.resume(id, this.cwd);
    this.pending = [];
    this.say(pc.dim(`resumed ${id} · ${plural(this.session.transcript().length, "turn")}`));
  }

  // -------------------------------------------------------------------------
  // /review and !shell
  // -------------------------------------------------------------------------

  async runReview(args: string[]): Promise<void> {
    const flags = parseReviewArgs(args);
    const target = await resolveTarget(specFrom(flags.target, flags), this.cwd);
    if (target.files.length === 0) {
      this.say(pc.dim(`nothing to review (${target.label})`));
      return;
    }

    const scan = makeProvider(resolveRole(this.reg, "scan", this.overrides));
    const verify = makeProvider(resolveRole(this.reg, "verify", this.overrides));
    this.say(
      pc.dim(`  reviewing ${target.label} — ${target.files.length} file(s) · scan=${scan.id} verify=${verify.id}`),
    );

    const started = Date.now();
    const ctl = new AbortController();
    let result;
    try {
      this.reader.beginTurn(() => ctl.abort());
      result = await review({
        target,
        scan,
        verify,
        cwd: this.cwd,
        trace: this.trace,
        policy: this.policy,
        // A fork, not this conversation: the pipeline builds its own review identity from
        // `prompts/identity.md` and the code-review skill, and inheriting the chat transcript
        // would both poison that prompt and blow its context.
        session: this.session.fork("review"),
        effort: this.effort,
        limits: this.limits(),
        signal: ctl.signal,
        skipVerify: !flags.verify,
        onProgress: (phase, detail) => this.say(pc.dim(`  [${phase}] ${detail}`)),
      });
    } finally {
      this.reader.endTurn();
    }

    process.stdout.write(
      `${renderTerminal(result, {
        label: target.label,
        usage: this.trace.usage(),
        models: { scan: scan.id, verify: verify.id },
        durationMs: Date.now() - started,
      })}\n`,
    );

    // The findings ride along with the next question. This is what makes "why is that one
    // wrong?" answerable without re-running anything.
    this.pending.push(digest(target.label, result));
    this.say(pc.dim("\n  findings are in context — ask about any of them"));
  }

  private async shell(command: string): Promise<void> {
    const decision = await this.policy.check("bash", bashTool.effect, { command });
    if (!decision.allowed) {
      this.say(pc.red(`  denied: ${decision.reason}`));
      return;
    }
    const ctl = new AbortController();
    let out;
    try {
      this.reader.beginTurn(() => ctl.abort());
      out = await bashTool.call(
        { command },
        { cwd: this.cwd, policy: this.policy, trace: this.trace, signal: ctl.signal },
      );
    } finally {
      this.reader.endTurn();
    }
    process.stdout.write(`${out.isError ? pc.red(out.content) : out.content}\n`);
    this.pending.push(`I ran \`${command}\` and got:\n\n\`\`\`\n${out.content.slice(0, 8000)}\n\`\`\``);
  }

  private completionsFor(command: string): string[] {
    switch (command) {
      case "/model":
        return this.reg.models.map((m) => m.id);
      case "/skill":
        return [...this.skills.keys()];
      case "/effort":
        return ["low", "medium", "high", "max"];
      case "/permission":
        return ["readonly", "ask", "auto", "deny"];
      case "/review":
        return ["--base", "--staged", "--no-verify"];
      default:
        return [];
    }
  }

  private reportError(e: unknown): void {
    if (e instanceof ProviderError) {
      this.say(pc.red(`  ${e.provider} ${e.kind}: ${e.message}`));
      if (e.kind === "auth") this.say(pc.dim("  set the provider's API key, or /model another one"));
      return;
    }
    this.say(pc.red(`  error: ${(e as Error).message ?? String(e)}`));
    if (process.env.KALEE_DEBUG) console.error(e);
  }
}

// ---------------------------------------------------------------------------

async function openSession(opts: ReplOptions, cwd: string, id: string): Promise<Session> {
  if (opts.resume) return Session.resume(opts.resume, cwd);
  if (opts.continueLatest) {
    const [latest] = await Session.list(cwd);
    if (latest) return Session.resume(latest.id, cwd);
    process.stderr.write(pc.dim("no previous session here — starting a new one\n"));
  }
  return new Session(id, cwd);
}

/** What the chat side of the session is told about a review it just ran. */
function digest(label: string, result: ReviewResult): string {
  if (result.findings.length === 0) {
    return `I ran a review of ${label}. It found no defects.`;
  }
  const body = result.findings
    .map(
      (f) =>
        `### ${f.file}:${f.line} — ${f.severity} ${f.category} (${f.verdict})\n` +
        `${f.summary}\n\nFailure scenario: ${f.failureScenario}` +
        (f.rationale ? `\n\nVerifier: ${f.rationale}` : ""),
    )
    .join("\n\n");
  return `I ran a review of ${label}. These are the findings, for reference if I ask about them:\n\n${body}`;
}

async function gitBranch(cwd: string): Promise<string | null> {
  const r = await exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, timeoutMs: 5_000 });
  const name = r.stdout.trim();
  return r.code === 0 && name ? name : null;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function ago(at: Date): string {
  const s = Math.max(0, (Date.now() - at.getTime()) / 1000);
  if (s < 90) return `${Math.round(s)}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
