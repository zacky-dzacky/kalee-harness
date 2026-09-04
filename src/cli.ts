#!/usr/bin/env bun
import { Command, Option } from "commander";
import pc from "picocolors";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { EFFORTS, ProviderError, type Effort } from "./model/ir.ts";
import { loadRegistry, lookup, resolveRole, writeProbedCaps, type Role } from "./model/registry.ts";
import { mergedCaps, probe } from "./model/doctor.ts";
import { makeProvider } from "./providers/index.ts";
import { ContextBuilder, repoMap } from "./core/context.ts";
import { loadOverlay, loadPrompt } from "./core/identity.ts";
import { limitsFrom, loadConfig } from "./core/config.ts";
import { runLoop } from "./core/loop.ts";
import { Policy, readonlyPolicy, type PermissionMode } from "./core/policy.ts";
import { Session } from "./core/session.ts";
import { newId, Trace } from "./core/trace.ts";
import { defaultRegistry } from "./tools/index.ts";
import { resolveTarget, type TargetSpec } from "./review/target.ts";
import { review } from "./review/pipeline.ts";
import { renderTerminal } from "./review/render/terminal.ts";
import { renderJson } from "./review/render/json.ts";
import { renderMarkdown } from "./review/render/markdown.ts";
import { postReview } from "./review/render/github.ts";
import { listCases, pct, runEval } from "./eval/run.ts";
import { sweep } from "./eval/sweep.ts";

const program = new Command();

program
  .name("kalee")
  .description("Kalee Harness — a model-agnostic agent harness with a code-review capability")
  .version("0.1.0");

// ---------------------------------------------------------------------------
// kalee review
// ---------------------------------------------------------------------------

program
  .command("review", { isDefault: true })
  .argument("[target]", "PR number, or a path. Omit to review the working tree.")
  .description("Review a change for correctness defects")
  .option("--base <ref>", "review merge-base(<ref>, HEAD)..HEAD")
  .option("--staged", "review staged changes")
  .option("--repo <owner/name>", "repository for a PR target")
  .option("--model <id>", "use one model for every role")
  .option("--role-model <spec>", "per-role models, e.g. scan=opus-5,verify=local-qwen")
  .addOption(new Option("--effort <level>", "reasoning effort").choices([...EFFORTS]))
  .addOption(new Option("--format <fmt>", "output format").choices(["terminal", "json", "markdown"]))
  .addOption(
    new Option("--permission-mode <mode>", "tool permissions").choices([
      "readonly", "ask", "auto", "deny",
    ]),
  )
  .option("--no-verify", "skip the verification pass (faster, noisier)")
  .option("--comment", "post findings as inline PR comments (PR target only)")
  .option("--max-turns <n>", "cap agent turns per pass", Number)
  .option("--max-cost <usd>", "cap spend for the run", Number)
  .action(async (targetArg: string | undefined, flags: ReviewFlags) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    const reg = await loadRegistry(cwd);
    const overrides = {
      model: flags.model ?? config.model,
      roleModels: { ...config.roleModels, ...parseRoleModels(flags.roleModel) },
    };

    const spec = targetSpec(targetArg, flags);
    const format = flags.format ?? config.format ?? "terminal";
    const quiet = format !== "terminal";

    if (flags.comment && spec.kind !== "pr") {
      fatal("--comment requires a PR target, e.g. `kalee review 1234 --comment`");
    }

    const target = await resolveTarget(spec, cwd);
    if (target.files.length === 0) {
      console.log(pc.dim(`Nothing to review (${target.label}).`));
      return;
    }

    const scan = makeProvider(resolveRole(reg, "scan", overrides));
    const verify = makeProvider(resolveRole(reg, "verify", overrides));

    const id = newId();
    const trace = new Trace(id, cwd);
    trace.write({ t: "run_start", at: new Date().toISOString(), command: "review", cwd });
    const session = new Session(id, cwd);
    const mode = (flags.permissionMode ?? config.permissionMode ?? "readonly") as PermissionMode;
    const policy = new Policy({
      mode,
      allow: config.allow,
      deny: config.deny,
      confirm: process.stdin.isTTY ? confirmTool : undefined,
    });

    if (!quiet) {
      console.error(
        pc.dim(`reviewing ${target.label} — ${target.files.length} file(s) · scan=${scan.id} verify=${verify.id}`),
      );
    }

    const started = Date.now();
    const result = await review({
      target,
      scan,
      verify,
      cwd,
      trace,
      policy,
      session,
      effort: (flags.effort ?? config.effort ?? "high") as Effort,
      limits: limitsFrom(config, {
        ...(flags.maxTurns ? { maxTurns: flags.maxTurns } : {}),
        ...(flags.maxCost ? { maxCostUsd: flags.maxCost } : {}),
      }),
      skipVerify: flags.verify === false,
      onProgress: quiet ? undefined : (phase, detail) => console.error(pc.dim(`  [${phase}] ${detail}`)),
    });

    await session.flush();
    await trace.finish();

    const meta = {
      label: target.label,
      usage: trace.usage(),
      models: { scan: scan.id, verify: verify.id },
      durationMs: Date.now() - started,
      traceId: id,
    };

    if (format === "json") console.log(renderJson(result, meta));
    else if (format === "markdown") console.log(renderMarkdown(result, meta));
    else console.log(renderTerminal(result, meta));

    if (flags.comment && spec.kind === "pr") {
      // Posting writes to someone else's pull request, so it is confirmed, never assumed.
      const n = result.findings.length;
      const okToPost =
        !process.stdin.isTTY ||
        (await ask(`Post ${n} finding${n === 1 ? "" : "s"} to PR #${spec.number}? [y/N] `));
      if (okToPost) {
        const posted = await postReview(result, { prNumber: spec.number, repo: flags.repo, cwd });
        console.error(pc.green(`posted ${posted.posted} comment(s)${posted.url ? ` — ${posted.url}` : ""}`));
      } else {
        console.error(pc.dim("not posted"));
      }
    }

    if (!quiet) console.error(pc.dim(`trace: ${trace.path}`));
    // Non-zero exit on a confirmed finding, so CI can gate on it.
    if (result.findings.some((f) => f.verdict === "confirmed")) process.exitCode = 1;
  });

interface ReviewFlags {
  base?: string;
  staged?: boolean;
  repo?: string;
  model?: string;
  roleModel?: string;
  effort?: Effort;
  format?: "terminal" | "json" | "markdown";
  permissionMode?: PermissionMode;
  verify?: boolean;
  comment?: boolean;
  maxTurns?: number;
  maxCost?: number;
}

function targetSpec(arg: string | undefined, flags: ReviewFlags): TargetSpec {
  if (flags.staged) return { kind: "staged" };
  if (flags.base) return { kind: "range", base: flags.base };
  if (arg === undefined) return { kind: "working-tree" };
  if (/^\d+$/.test(arg)) return { kind: "pr", number: Number(arg), repo: flags.repo };
  return { kind: "path", path: arg };
}

function parseRoleModels(spec: string | undefined): Partial<Record<Role, string>> {
  if (!spec) return {};
  const out: Partial<Record<Role, string>> = {};
  for (const pair of spec.split(",")) {
    const [role, model] = pair.split("=");
    if (!role || !model) fatal(`bad --role-model \`${pair}\`; expected role=model`);
    if (role !== "scan" && role !== "verify" && role !== "default") {
      fatal(`unknown role \`${role}\`; expected scan, verify or default`);
    }
    out[role as Role] = model;
  }
  return out;
}

// ---------------------------------------------------------------------------
// kalee ask — raw harness access, which proves the core is general
// ---------------------------------------------------------------------------

program
  .command("ask")
  .argument("<prompt>", "what to ask")
  .description("Run the agent loop directly against a prompt")
  .option("--model <id>", "model to use")
  .addOption(new Option("--effort <level>").choices([...EFFORTS]))
  .addOption(
    new Option("--permission-mode <mode>").choices(["readonly", "ask", "auto", "deny"]),
  )
  .option("--no-tools", "disable tools entirely")
  .action(async (prompt: string, flags: { model?: string; effort?: Effort; permissionMode?: PermissionMode; tools?: boolean }) => {
    const cwd = process.cwd();
    const config = await loadConfig(cwd);
    const reg = await loadRegistry(cwd);
    const provider = makeProvider(
      resolveRole(reg, "default", { model: flags.model ?? config.model }),
    );

    const id = newId();
    const trace = new Trace(id, cwd);
    trace.write({ t: "run_start", at: new Date().toISOString(), command: "ask", cwd });
    const session = new Session(id, cwd);
    const mode = (flags.permissionMode ?? config.permissionMode ?? "readonly") as PermissionMode;
    const policy = new Policy({
      mode,
      confirm: process.stdin.isTTY ? confirmTool : undefined,
    });

    const system = new ContextBuilder()
      .addStable("You are Kalee, a terse and precise coding assistant with read-only access to this repository.")
      .overlay(await loadOverlay(cwd))
      .addStable(flags.tools === false ? null : await repoMap(cwd))
      .build();

    session.user([{ type: "text", text: prompt }]);

    const result = await runLoop({
      provider,
      tools: flags.tools === false ? defaultRegistry().select([]) : defaultRegistry(),
      system,
      session,
      trace,
      policy,
      cwd,
      pass: "ask",
      effort: flags.effort ?? config.effort ?? "medium",
      limits: limitsFrom(config),
      onText: (t) => process.stdout.write(t),
    });

    process.stdout.write("\n");
    await session.flush();
    await trace.finish();
    const u = trace.usage();
    console.error(
      pc.dim(
        `\n${provider.id} · ${u.input} in / ${u.output} out${u.cacheRead ? ` (${u.cacheRead} cached)` : ""} · $${trace.costUsd().toFixed(4)}`,
      ),
    );
    if (result.haltReason) console.error(pc.yellow(`halted: ${result.haltReason}`));
  });

// ---------------------------------------------------------------------------
// kalee models / doctor
// ---------------------------------------------------------------------------

program
  .command("models")
  .description("List the registry and resolved capabilities")
  .action(async () => {
    const reg = await loadRegistry(process.cwd());
    console.log(pc.dim(reg.path));
    console.log("");
    for (const m of reg.models) {
      const roles = Object.entries(reg.roles)
        .filter(([, id]) => id === m.id)
        .map(([r]) => r);
      const tag = roles.length ? pc.green(` [${roles.join(", ")}]`) : "";
      console.log(`${pc.bold(m.id)}${tag}  ${pc.dim(`${m.provider} · ${m.apiModel}`)}`);
      if (m.baseURL) console.log(`  ${pc.dim(m.baseURL)}`);
      const c = m.caps;
      console.log(
        `  ${c.nativeToolCalls ? "native tools" : pc.yellow("shimmed tools")}` +
          `, ${c.parallelToolCalls ? "parallel" : "serial"}` +
          `, reasoning=${c.reasoning}, context=${c.maxContext.toLocaleString()}`,
      );
      const p = m.pricing;
      console.log(
        pc.dim(
          `  $${p.input}/MTok in, $${p.output}/MTok out${p.cacheRead != null ? `, $${p.cacheRead} cache read` : ""}`,
        ),
      );
      console.log("");
    }
  });

program
  .command("doctor")
  .argument("<model>", "registry model id")
  .description("Probe a backend's real capabilities and write them back to models.yaml")
  .option("--no-write", "probe only; do not modify models.yaml")
  .action(async (modelId: string, flags: { write?: boolean }) => {
    const reg = await loadRegistry(process.cwd());
    const entry = lookup(reg, modelId);
    console.log(pc.dim(`probing ${entry.id} (${entry.provider} · ${entry.apiModel})`));
    if (entry.baseURL) console.log(pc.dim(entry.baseURL));
    console.log("");

    const results = await probe(entry, (name) => process.stderr.write(pc.dim(`  ${name}… `)));
    for (const r of results) {
      process.stderr.write("\r");
      console.log(`${r.ok ? pc.green("✓") : pc.yellow("✗")} ${r.name.padEnd(22)} ${pc.dim(r.detail)}`);
    }

    const caps = mergedCaps(results);
    const changed = Object.entries(caps).filter(
      ([k, v]) => entry.caps[k as keyof typeof entry.caps] !== v,
    );
    console.log("");
    if (changed.length === 0) {
      console.log(pc.dim("registry already matches what the backend does."));
      return;
    }
    for (const [k, v] of changed) {
      console.log(`  ${k}: ${pc.red(String(entry.caps[k as keyof typeof entry.caps]))} → ${pc.green(String(v))}`);
    }
    if (flags.write === false) {
      console.log(pc.dim("\n--no-write: models.yaml left unchanged."));
      return;
    }
    await writeProbedCaps(reg, entry.id, caps);
    console.log(pc.green(`\nwrote ${changed.length} correction(s) to ${reg.path}`));
  });

// ---------------------------------------------------------------------------
// kalee eval
// ---------------------------------------------------------------------------

const evalCmd = program.command("eval").description("Benchmark the reviewer against seeded fixtures");

evalCmd
  .command("run", { isDefault: true })
  .description("Score recall and precision over the fixtures")
  .option("--model <id>", "model for both roles")
  .option("--case <names>", "comma-separated fixture names")
  .option("--no-verify", "skip the verification pass")
  .option("--json", "emit the raw report")
  .action(async (flags: { model?: string; case?: string; verify?: boolean; json?: boolean }) => {
    const reg = await loadRegistry(process.cwd());
    const scan = makeProvider(resolveRole(reg, "scan", { model: flags.model }));
    const verify = makeProvider(resolveRole(reg, "verify", { model: flags.model }));
    const cases = flags.case?.split(",").map((s) => s.trim());

    const report = await runEval({
      scan,
      verify,
      cases,
      skipVerify: flags.verify === false,
      onProgress: flags.json ? undefined : (m) => console.error(pc.dim(`  ${m}`)),
    });

    if (flags.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log("");
    for (const s of report.scores) {
      const clean = s.expected === 0;
      const good = clean ? s.found === 0 : s.recall >= 0.99 && s.falsePositives.length === 0;
      const mark = good ? pc.green("✓") : pc.yellow("!");
      console.log(
        `${mark} ${s.case.padEnd(22)} ${pc.dim(
          clean
            ? `${s.found} finding(s) on a clean fixture — want 0`
            : `recall ${pct(s.recall)} · precision ${pct(s.precision)} · ${s.matched.length}/${s.expected} found, ${s.falsePositives.length} extra`,
        )}`,
      );
      for (const m of s.missed) console.log(pc.dim(`    missed ${m.file}:${m.line} — ${m.hint}`));
      for (const f of s.trapsHit) console.log(pc.red(`    trap   ${f.file}:${f.line} — ${f.summary}`));
    }

    const t = report.total;
    console.log("");
    console.log(
      pc.bold(`recall ${pct(t.recall)} · precision ${pct(t.precision)} · F1 ${t.f1.toFixed(2)}`) +
        pc.dim(` · $${t.costUsd.toFixed(4)} · ${(t.durationMs / 1000).toFixed(0)}s · ${t.cases} cases`),
    );
    if (t.trapsHit > 0) console.log(pc.red(`${t.trapsHit} trap(s) hit`));
  });

evalCmd
  .command("sweep")
  .description("Run the fixtures across several backends and report quality per dollar")
  .requiredOption("--models <ids>", "comma-separated registry model ids")
  .option("--case <names>", "comma-separated fixture names")
  .option("--no-verify", "skip the verification pass")
  .action(async (flags: { models: string; case?: string; verify?: boolean }) => {
    const reg = await loadRegistry(process.cwd());
    const ids = flags.models.split(",").map((s) => s.trim()).filter(Boolean);
    const rows = await sweep(reg, ids, {
      cases: flags.case?.split(",").map((s) => s.trim()),
      skipVerify: flags.verify === false,
      onProgress: (m) => console.error(pc.dim(m)),
    });

    console.log("");
    console.log(pc.bold("model".padEnd(16) + "recall".padEnd(9) + "prec".padEnd(9) + "F1".padEnd(7) + "cost".padEnd(10) + "F1/$"));
    console.log(pc.dim("─".repeat(60)));
    for (const r of rows) {
      if (r.error) {
        console.log(`${r.model.padEnd(16)}${pc.red(r.error.slice(0, 44))}`);
        continue;
      }
      const perDollar = r.valuePerDollar === Infinity ? "free" : r.valuePerDollar.toFixed(1);
      console.log(
        r.model.padEnd(16) +
          pct(r.recall).padEnd(9) +
          pct(r.precision).padEnd(9) +
          r.f1.toFixed(2).padEnd(7) +
          `$${r.costUsd.toFixed(3)}`.padEnd(10) +
          perDollar,
      );
    }
  });

evalCmd
  .command("list")
  .description("List the available fixtures")
  .action(async () => {
    for (const c of await listCases()) console.log(c);
  });

// ---------------------------------------------------------------------------
// kalee trace
// ---------------------------------------------------------------------------

program
  .command("trace")
  .argument("<session-id>")
  .description("Replay a run's trace: turns, tool calls, cost and latency")
  .option("--json", "emit raw records")
  .action(async (id: string, flags: { json?: boolean }) => {
    const path = join(process.cwd(), ".kalee", "traces", `${id}.jsonl`);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      fatal(`no trace at ${path}`);
      return;
    }
    const events = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    if (flags.json) {
      console.log(JSON.stringify(events, null, 2));
      return;
    }
    for (const e of events) {
      switch (e.t) {
        case "run_start":
          console.log(pc.bold(`${e.command} in ${e.cwd}`), pc.dim(e.at));
          break;
        case "turn_end":
          console.log(
            `${pc.cyan(`[${e.pass}]`)} turn ${e.turn} ${pc.dim(
              `${e.model} · ${e.usage.input} in / ${e.usage.output} out · $${e.costUsd.toFixed(4)} · ${e.durationMs}ms · ${e.stop}`,
            )}`,
          );
          break;
        case "tool_call": {
          const mark = !e.allowed ? pc.red("denied") : e.isError ? pc.yellow("error") : pc.green("ok");
          console.log(
            `  ${mark} ${e.tool} ${pc.dim(`(${e.effect}) ${e.durationMs}ms${e.reason ? ` — ${e.reason}` : ""}`)}`,
          );
          break;
        }
        case "finding":
          console.log(`  ${pc.magenta("finding")} ${e.finding.file}:${e.finding.line} ${pc.dim(e.finding.summary)}`);
          break;
        case "error":
          console.log(`  ${pc.red("error")} ${e.kind}: ${e.message}`);
          break;
        case "note":
          console.log(pc.dim(`  note [${e.pass}] ${e.message}`));
          break;
        case "run_end":
          console.log(
            pc.bold(
              `\ntotal ${e.usage.input} in / ${e.usage.output} out${e.usage.cacheRead ? ` (${e.usage.cacheRead} cached)` : ""} · $${e.costUsd.toFixed(4)} · ${(e.durationMs / 1000).toFixed(1)}s`,
            ),
          );
          break;
        default:
          break;
      }
    }
  });

// ---------------------------------------------------------------------------

function fatal(msg: string): never {
  console.error(pc.red(`error: ${msg}`));
  process.exit(2);
}

async function ask(question: string): Promise<boolean> {
  process.stderr.write(question);
  for await (const line of console) {
    return /^y(es)?$/i.test(line.trim());
  }
  return false;
}

function confirmTool(tool: string, effect: string, input: unknown): Promise<boolean> {
  const preview = JSON.stringify(input);
  return ask(
    `${pc.yellow("permission")} ${tool} (${effect}) ${pc.dim(preview.slice(0, 120))}\nallow? [y/N] `,
  );
}

// Provider failures are expected operating conditions, not crashes; report them as such.
try {
  await program.parseAsync(process.argv);
} catch (e) {
  if (e instanceof ProviderError) {
    console.error(pc.red(`\n${e.provider} ${e.kind}: ${e.message}`));
    if (e.kind === "auth") {
      console.error(pc.dim("Set the provider's API key, or pick another model with --model."));
    }
    process.exit(1);
  }
  console.error(pc.red(`\nerror: ${(e as Error).message ?? String(e)}`));
  if (process.env.KALEE_DEBUG) console.error(e);
  process.exit(1);
}
