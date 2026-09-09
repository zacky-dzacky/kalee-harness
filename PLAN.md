# Kalee Harness — v1 Skeleton (Model-Agnostic, Code Review Capability)

## Context

You want your own agent harness ("Kalee Harness") in the spirit of Claude Code, structured around the
layer diagram in `LAYERS.md`. Building every layer at once produces a framework
with nothing running on it, so v1 narrows to **one capability — code review**, chosen deliberately:
review needs *only read-only tools* (so the Sandbox layer is trivially safe in v1) and it needs
*multi-pass orchestration* (scan → verify), which forces the Agent Loop and Orchestration layers to be
real rather than decorative.

The harness is **model-agnostic**: Anthropic, OpenAI, Gemini, Ollama, MLX and others, with no
provider wire format leaking above the provider boundary.

Target outcome: `kalee review --base main` produces ranked, verified findings with `file:line`, on a
harness whose module boundaries match your diagram and whose model backend is swappable by config.

Decisions: **TypeScript on Bun** · **one-shot command** (the REPL later landed on the same core, as
planned) · targets = **local git diff**, **arbitrary path**, **GitHub PR via `gh`**.

---

## Current state — 2026-09-09

**v1 is built.** M0–M9 are all complete, and the REPL that this plan deferred to "later" exists as
well. `bun test` passes **172 tests** (1 skipped: the live cache-regression test, which needs
`KALEE_LIVE_CACHE=1`), `tsc --noEmit` is clean, and `bun run build` produces `dist/kalee`. ~9.5k
lines across `src/` and `test/`.

Running today:

- All three native adapters (`anthropic.ts`, `openai.ts`, `google.ts`) plus `shim.ts`, behind the
  one conformance suite (`test/conformance.ts`) every adapter must pass.
- The agent loop, seven read-only tools plus the policy-gated `bash` escape hatch, the
  scan → verify review pipeline, all four renderers, `kalee doctor`, and all eight eval fixtures.
- All five review targets: working tree, staged, range, path, GitHub PR.
- An interactive REPL (`kalee repl`) with 15 slash commands, session resume, and `/review`.

Three deliberate divergences from the plan as written below:

- **`roles:` in `models.yaml` currently points every role at `local-qwen7b`**, not
  `scan: opus-5 / verify: local-qwen`. That is a local-development default, not the intended
  production assignment — override per run with `--role-model`, or edit the registry.
- **Three modules exist that the skeleton did not name.** `core/roots.ts` — the runtime-data
  discipline needed its own resolver, because inside a `bun build --compile` binary
  `import.meta.url` is a virtual path and deriving `prompts/` from the source location finds
  nothing. `core/config.ts` — the `~/.kalee` + `.kalee` merge. `src/repl/` — four modules.
- **`core/text.ts` and `core/index.ts`** are small shared helpers that fell out of the REPL work.

Still deferred, unchanged from the plan: MCP tool discovery, durable memory, code substrate,
`sandbox-exec`/landlock behind `tools/exec.ts`, and learned cache routing.

---

## Language rationale

The first pass of this plan chose Rust. Multi-provider support changed the answer, and it's worth
recording why so the decision isn't re-litigated later.

Two arguments for Rust that did **not** survive scrutiny: *"~5ms startup for a CLI you invoke
constantly"* — you don't invoke a code reviewer constantly, and each run blocks on a 30-second model
call, so startup is noise; and *"the Sandbox layer needs OS primitives"* — true, but this plan itself
marks that layer partial in v1 and later beyond, so it can't justify the language.

What actually decided it: the work is **protocol integration and prompt engineering**, not systems
programming. Official SDKs exist for Anthropic, OpenAI, *and* Google in TypeScript — each absorbing
transport, auth, retries, streaming accumulation, and **upstream API drift** independently. That is
most of each adapter's line count, times three, and it's precisely the part that rots. Rust's real
edge (sum types for the IR) buys elegance in the one file that was never the hard part, while its tax
— accumulating streaming partial JSON into typed structs, and untagged-enum gymnastics for
polymorphic content blocks where a field is sometimes a string and sometimes an object — scales with
every provider added. TypeScript models those blocks as a union type and moves on.

`bun build --compile` produces a single binary, which neutralizes the remaining Rust argument.

**Two disciplines that make this choice safe** (without them, the abstraction rots and you get the
worst of both):

1. **Exhaustive discriminated unions.** Every `switch` over `Block` / `Event` ends in an
   `assertNever(x)` default. Adding an IR variant then fails compilation in *every* adapter rather
   than silently no-oping in one. This recovers most of what Rust enums were buying.
2. **Prompts and the model registry are runtime data.** `skills/`, `prompts/`, and `models.yaml` are
   read from disk at run time, never bundled as constants. Prompt iteration is where most of the real
   work in an agent harness happens; it must not require a rebuild.

---

## Skeleton

```
kalee_harness/
├── package.json · tsconfig.json · bunfig.toml
├── KALEE.md                      # project identity overlay
├── models.yaml                   # registry: ids, endpoints, pricing, capabilities (runtime data)
├── src/
│   ├── cli.ts                    # commander wiring, output rendering
│   ├── model/
│   │   ├── ir.ts                 # canonical IR — the contract
│   │   ├── provider.ts           # ModelProvider interface, Capabilities, Pricing
│   │   ├── registry.ts           # models.yaml loader + role resolution
│   │   └── doctor.ts             # capability probing, writes caps back to models.yaml
│   ├── providers/
│   │   ├── anthropic.ts          # @anthropic-ai/sdk
│   │   ├── openai.ts             # openai — also Ollama, MLX, LM Studio, vLLM, OpenRouter
│   │   ├── google.ts             # @google/genai
│   │   ├── shim.ts               # text tool-call protocol for models without native tool use
│   │   └── index.ts              # registry entry -> provider construction
│   ├── core/
│   │   ├── loop.ts               # the agent loop
│   │   ├── context.ts            # compiled context
│   │   ├── identity.ts · skills.ts · session.ts
│   │   ├── policy.ts · trace.ts · budget.ts · compact.ts
│   │   ├── roots.ts              # runtime-data discovery (survives --compile)   [unplanned]
│   │   ├── config.ts             # ~/.kalee + .kalee merge                       [unplanned]
│   │   └── text.ts · index.ts    # shared helpers                                [unplanned]
│   ├── tools/                    # Tool interface + read-only builtins + sandboxed exec
│   ├── review/                   # the code-review capability (deterministic half)
│   ├── repl/                     # interactive session: repl · commands · input · render
│   └── eval/                     # fixture scoring + cross-provider sweeps
├── skills/code-review/SKILL.md   # the code-review capability (behavioral half)
├── prompts/{identity,verify,repl}.md
├── fixtures/                     # 8 eval repos with seeded bugs + expected.json
├── test/                         # 13 files, 173 tests
└── .kalee/{sessions,traces}/     # append-only JSONL, written at run time
```

### Layer → module map (keep this visible in the code)

| `LAYERS.md` box | Module | Status |
|---|---|---|
| Durable identity | `prompts/identity.md` + `core/identity.ts` (+ `prompts/repl.md`) | ✅ built |
| Loadable skills | `core/skills.ts` (frontmatter + progressive disclosure) | ✅ built |
| Compiled context | `core/context.ts` | ✅ built |
| Adaptation limits | `core/budget.ts` (turn/token/wallclock/cost caps) | ✅ built |
| Sandbox runtime / Resource bounds / OS permissions | `tools/exec.ts` (cwd jail, process-group timeout, output cap, denylist) | partial — `sandbox-exec`/landlock still to drop in behind the same interface |
| Code substrate | — | later |
| Tool schema / Protocol / Discovery / Routing | `tools/` + zod schemas | ✅ built (MCP discovery later) |
| Active context / Session state / Durable memory / State artifacts | `core/session.ts` (+ `/resume`, `/compact`) | ✅ built (cross-session memory later) |
| Agent loop / Multi-agent / Handoff / Task pipeline | `core/loop.ts` + `review/pipeline.ts` | ✅ built |
| Caching & compression | `CacheSpan` + `core/compact.ts` | ✅ built (learned routing later) |
| Benchmark grounding / Readiness / Regression | `src/eval/` + 8 fixtures | ✅ built |
| Execution traces / Cost & latency / Failure attribution | `core/trace.ts` | ✅ built |
| Permission control / Policy / Audit / Guardrails | `core/policy.ts` | ✅ built |
| *(no box — falls out of the core)* | `src/repl/` interactive session | ✅ built, beyond v1 scope |

---

## The model-agnostic layer (the load-bearing design)

A "swap the base URL" wrapper does not work. Providers diverge structurally:

| | Anthropic | OpenAI-compatible | Gemini | Small local models |
|---|---|---|---|---|
| Tool protocol | `tool_use`/`tool_result` blocks | `tool_calls` + `role:"tool"` | `functionCall`/`functionResponse` parts | **often none — emitted as prose** |
| Reasoning | signed thinking blocks, replayed verbatim | encrypted reasoning items | thought signatures | none |
| Caching | explicit `cache_control` breakpoints | automatic prefix caching | cached-content handles + TTL | none |
| System prompt | top-level field | first message | `systemInstruction` | first message |
| Context | 200k–1M | 128k–1M | 1M+ | **8k–32k** |

So: **a canonical IR plus bidirectional adapters.** Core never imports a provider type.

```ts
// src/model/ir.ts
export type Block =
  | { type: "text";        text: string }
  | { type: "reasoning";   summary?: string; opaque?: OpaqueReasoning }
  | { type: "tool_call";   id: string; name: string; input: unknown }
  | { type: "tool_result"; id: string; content: Block[]; isError: boolean };

export type Event =
  | { type: "text_delta";      text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; json: string }
  | { type: "turn_end";        stop: StopReason; usage: Usage };

export interface Request {
  system: CacheSpan[];        // core marks stable prefixes; adapter decides how to cache
  turns: Turn[];
  tools: ToolDef[];
  effort: Effort;             // low..max — adapter maps to native knob or ignores
  maxOutputTokens: number;
}
```

Three pieces carry most of the weight:

- **`OpaqueReasoning`** — `{ provider, model, payload }`. The adapter replays it **only** when the
  same provider *and* model produced it, and drops it otherwise. This is the detail naive
  abstractions miss: replaying Anthropic thinking blocks to OpenAI is a 400, and dropping them when
  they *should* be replayed is an invisible quality loss where the model forgets its own reasoning
  across turns.
- **`CacheSpan`** — core declares *"this prefix is stable, cache from here."* The adapter decides how:
  Anthropic inserts `cache_control`, OpenAI no-ops (automatic), Gemini creates or reuses a
  cached-content handle, local models ignore it.
- **`Capabilities`** — so the loop degrades instead of crashing:

```ts
export interface Capabilities {
  nativeToolCalls: boolean;    // false -> route through providers/shim.ts
  parallelToolCalls: boolean;  // false -> loop serializes dispatch
  reasoning: "none" | "effort" | "budget" | "always-on";
  explicitCacheBreakpoints: boolean;
  strictToolSchemas: boolean;  // false -> validate-and-retry wrapper
  maxContext: number;
  vision: boolean;
}

export interface ModelProvider {
  readonly id: string;
  readonly caps: Capabilities;
  readonly pricing: Pricing;   // input/output/cacheRead/cacheWrite per MTok
  stream(req: Request, signal: AbortSignal): AsyncIterable<Event>;
  countTokens(req: Request): Promise<number>;
}
```

### Adapters

**Native (three wire formats — covers everything):**

| Adapter | SDK | Covers |
|---|---|---|
| `anthropic.ts` | `@anthropic-ai/sdk` | Claude models |
| `openai.ts` | `openai` + `baseURL` override | OpenAI, **Ollama** (`:11434/v1`), **MLX** (`mlx_lm.server`), LM Studio, vLLM, llama.cpp, OpenRouter, Groq, Together, DeepSeek, Mistral, xAI |
| `google.ts` | `@google/genai` | Gemini |

`openai.ts` is the highest-leverage file in the project: one adapter, a dozen backends. Gemini also
exposes an OpenAI-compatible endpoint, but it degrades (no thought signatures, weaker tool support) —
use the native adapter and keep the compat path only as a fallback.

### The tool-call shim — what makes local support real

**This is the part that makes "supports Ollama and MLX" true rather than aspirational.** Many local
models — and `mlx_lm.server` in particular, where tool support depends entirely on the model's chat
template — cannot emit structured `tool_calls`. They describe the call in prose instead. An agent
harness that assumes native tool calling simply does not work against them.

`providers/shim.ts` wraps any provider whose `caps.nativeToolCalls` is false:

- renders tool schemas into the system prompt with a strict convention
  (`<tool_call>{"name":..., "input":...}</tool_call>`);
- incrementally parses the text stream for that convention, buffering across chunk boundaries so a
  tag split mid-token doesn't leak, and emits real `tool_call_start` / `tool_call_delta` events;
- suppresses the tool-call region from user-visible text deltas.

Core sees identical `Event`s either way.

### `kalee doctor` — probe, don't assume

Local capabilities vary **per model**, not per provider: two models behind the same Ollama endpoint
can differ on tool calling. So capabilities are probed, not declared. `kalee doctor <model>` runs a
short battery — does it stream? does it return structured tool calls? does it honor a JSON schema?
what is the real context window? — and writes the results back into `models.yaml`. This is what keeps
the registry honest for local backends.

### Registry (`models.yaml`, runtime data)

```yaml
models:
  - id: opus-5
    provider: anthropic
    apiModel: claude-opus-5
    pricing: { input: 5.00, output: 25.00, cacheRead: 0.50 }
    caps: { nativeToolCalls: true, parallelToolCalls: true, reasoning: always-on,
            explicitCacheBreakpoints: true, maxContext: 1000000 }

  - id: local-qwen
    provider: openai
    baseURL: http://localhost:11434/v1     # Ollama
    apiModel: qwen2.5-coder:32b
    pricing: { input: 0, output: 0 }
    caps: { nativeToolCalls: true, parallelToolCalls: false, reasoning: none,
            explicitCacheBreakpoints: false, maxContext: 32768 }

  - id: mlx-devstral
    provider: openai
    baseURL: http://localhost:8080/v1      # mlx_lm.server
    apiModel: mlx-community/Devstral-Small-2507-4bit
    caps: { nativeToolCalls: false, ... }  # -> shim; confirm with `kalee doctor`

roles:
  scan:   opus-5        # needs judgment
  verify: local-qwen    # cheap, high volume, narrow question
```

The shipped `models.yaml` matches this shape and carries eight entries (`opus-5`, `sonnet-5`,
`haiku-4-5`, `gpt-5`, `gemini-3-pro`, `local-qwen7b`, `local-qwen`, `mlx-devstral`). Its `roles:`
block currently points every role at `local-qwen7b` — a local-development default, not the
assignment above. Override per run with `--role-model scan=opus-5,verify=haiku-4-5`.

**Role-based model assignment** falls out of the design and is genuinely useful. Caches are provider-
and model-scoped, so switching models mid-session would invalidate them — but scan and verify are
already separate contexts, so per-role models cost nothing and unlock the eval sweep below.

### Context budgeting for small models

`caps.maxContext` is load-bearing once local models are in play: a 60k-token diff cannot go to a 32k
model. `core/budget.ts` measures the compiled context against the target model and, when it
overflows, the scan pass degrades to **per-file map-reduce** instead of failing. Chunking per file is
a natural fit for review anyway, and it puts real work through the Task-pipeline layer.

---

## Tools

```ts
export interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;                       // -> JSON Schema via zod-to-json-schema
  effect: "read-only" | "mutating" | "external";
  parallelSafe: boolean;
  call(input: unknown, ctx: ToolCtx): Promise<ToolOutput>;
}
```

`effect` is the seam that makes Governance real: `core/policy.ts` gates on it, `core/trace.ts` records
it, `core/loop.ts` uses `parallelSafe` to decide fan-out. v1 builtins are **all read-only**:

| Tool | Why dedicated rather than bash |
|---|---|
| `read_file(path, offset?, limit?)` | line numbering, byte cap, path jail, context dedupe |
| `grep(pattern, path?, glob?)` | shells to `rg --json` when present, JS scanner fallback |
| `glob(pattern)` | `Bun.Glob`, parallel-safe, respects `.gitignore` |
| `git_diff` / `git_show` / `git_blame` | harness caches and renders these; review's core signal |
| `report_finding(...)` | zod schema — the only path by which findings enter the pipeline |
| `bash(command, timeoutMs)` | breadth escape hatch, gated by policy |

Principle: start with bash for breadth; promote an action to a dedicated tool when you need to gate,
render, audit, or parallelize it.

`tools/exec.ts` — the sandbox seam. v1: cwd jail, wall-clock timeout killing the **whole process
group** (`Bun.spawn` + `kill(-pid)`), output byte cap, command denylist. Shaped so `sandbox-exec` and
landlock drop in behind the same interface later without touching callers.

---

## Core

- **`loop.ts`** — written against the IR only. Request → stream → on `stop: "tool_call"`, dispatch
  (concurrently when every call is `parallelSafe` **and** `caps.parallelToolCalls`, serially
  otherwise) → **return all tool results in a single user turn** — splitting them across turns trains
  models to stop calling tools in parallel → repeat until `stop: "end_turn"`. Failed tools return a
  result with `isError: true`; never dropped.
- **`context.ts`** — identity + selected skill bodies + repo map + target payload → system
  `CacheSpan`s and the opening turn. Everything volatile (timestamps, the diff, the question) goes
  *after* the last cache span, or caching silently never hits.
- **`skills.ts`** — a skill is a directory with `SKILL.md` (YAML frontmatter: `name`, `description`,
  optional `tools`). Descriptions sit in context; bodies load on selection.
- **`session.ts`** — transcript + **append-only** JSONL at `.kalee/sessions/<id>.jsonl`. Append-only
  matters: editing earlier turns invalidates caches and breaks reasoning-block replay.
- **`policy.ts`** — modes `readonly` (v1 default) / `ask` / `auto` / `deny`, plus allow/deny globs.
  Every decision emits an audit record.
- **`trace.ts`** — JSONL at `.kalee/traces/<id>.jsonl`: turn boundaries, each tool call with duration
  and `effect`, per-turn usage, cost computed from registry `Pricing`. This *is* the audit trail —
  one writer, two consumers.
- **`budget.ts`** — turn, token, and wall-clock caps enforced locally, since not every backend has a
  server-side budget knob.

---

## Review capability

- **`target.ts`** — `WorkingTree | Staged | Range{base,head} | Path | GitHubPr`, all normalizing to
  one `ReviewTarget { files: FileChange[], kind }`. Git via `Bun.spawn` wrappers (`merge-base`,
  `diff --numstat`, per-file patches). PR target shells to `gh pr diff` / `gh api`.
- **`pipeline.ts`** — two passes:
  1. **Scan** — agent loop over the target with read-only tools, `scan` role model, effort `high`.
     Emits candidates via `report_finding`. Degrades to per-file map-reduce under `maxContext`.
  2. **Verify** — each candidate re-checked in a *fresh, isolated* context using the `verify` role
     model: "here is the claim and the failure scenario; read the actual code; does it hold?" →
     `confirmed | plausible | rejected`. Rejected findings are dropped.

  The verify pass is the single biggest precision lever, and it's why review is the right first
  capability: it exercises sub-agent orchestration, handoff state, and per-role model routing without
  needing a single write tool.
- **`finding.ts`** — `{ file, line, severity, category, summary, failureScenario, verdict }`.
- **`render/`** — `terminal.ts` (ranked, colored, clickable `file:line`), `json.ts`, `markdown.ts`,
  `github.ts` (inline PR comments via `gh api`, behind `--comment`).

---

## Eval

`fixtures/<case>/` holds a small repo, a diff, and `expected.json` (ground-truth bugs plus known
false-positive traps). `kalee eval run` scores recall / precision / cost / latency per case.

Because the model layer is abstract, `kalee eval sweep --models opus-5,gpt-5,gemini-3-pro,local-qwen`
runs the same fixtures across backends and reports **quality per dollar** — a strong feature for a
review tool, and the honest way to decide which model each role deserves.

Start with ~8 cases: off-by-one, null deref, swallowed error, race on shared state, wrong-order args,
resource leak, plus **two clean diffs that must produce zero findings**.

---

## CLI (v1)

```
kalee review                      # working tree vs HEAD
kalee review --staged
kalee review --base main          # merge-base(main, HEAD)..HEAD
kalee review 1234                 # GitHub PR via gh
kalee review src/auth/            # path mode (no diff signal — different prompt)
  --model <id> | --role-model scan=<id>,verify=<id>
  --effort low|medium|high|max
  --format terminal|json|markdown
  --comment                       # inline PR comments (PR target only)
  --permission-mode readonly|ask|auto
kalee models                      # registry + resolved capabilities
kalee doctor <model>              # probe a backend, write caps back to models.yaml
kalee ask "<prompt>"              # raw harness access — proves the core is general
kalee eval run | sweep | list
kalee trace <session-id>
kalee repl                        # interactive session (was "later"; shipped)
```

All of the above exist. `kalee repl` carries 15 slash commands — `/help /exit /model /effort
/permission /review /cost /tools /skills /skill /clear /compact /trace /sessions /resume` — plus
`--continue` / `--resume <id>` and a session-wide `--max-cost`.

Config: `~/.kalee/config.yaml` merged with `.kalee/config.yaml`; `KALEE.md` is the project identity
overlay; `models.yaml` is the registry.

---

## Dependencies

`@anthropic-ai/sdk` · `openai` · `@google/genai` · `zod` + `zod-to-json-schema` (tool schemas) ·
`commander` (CLI) · `yaml` (registry, config, skill frontmatter) · `picocolors`. Subprocess, glob,
file I/O and the test runner come from Bun natively — no `execa`, `fast-glob`, or `jest`.

Token counting goes through the provider (`countTokens` where offered, adapter estimate otherwise),
never a bundled local tokenizer, which would be wrong for every model but one.

---

## Milestones

| # | Deliverable | Done when | Status |
|---|---|---|---|
| M0 | Repo + IR + `anthropic.ts` | `kalee ask "hi"` streams tokens | ✅ |
| M1 | `openai.ts` + **provider conformance suite** | Suite passes on both; `kalee ask --model local-qwen` works against Ollama | ✅ `test/conformance.ts` |
| M2 | Tool interface + read-only builtins + agent loop | `kalee ask "how many TS files, and the largest?"` completes via tool calls on **both** backends | ✅ |
| M3 | Review scan pass + git-diff target | `kalee review --base main` prints unverified findings | ✅ |
| M4 | Verify pass + role models + renderers | `--format json` emits verdict-carrying findings; rejects dropped | ✅ 4 renderers |
| M5 | `google.ts` (Gemini) | Third wire format passes the same conformance suite unchanged | ✅ |
| M6 | `shim.ts` + `kalee doctor` | A model with `nativeToolCalls: false` on MLX completes a full review | ✅ shim tested; `mlx-devstral` in registry |
| M7 | policy + trace + budget + context chunking | Trace shows per-tool effect/cost/latency; a 60k diff reviews on a 32k model | ✅ `test/chunking.test.ts` |
| M8 | `eval run` + 8 fixtures + `sweep` | Recall/precision per model; clean diffs score 0 findings | ✅ 6 bug fixtures + 2 clean |
| M9 | Path target + `gh` PR target + `--comment` | `kalee review 1234 --comment` posts inline comments | ✅ all 5 targets |
| M10 | `kalee repl` | Interactive session on the same core, with `/review` and resume | ✅ beyond original v1 scope |

M0–M4 is the useful product. Building the **conformance suite at M1 rather than last** is the key
sequencing decision: it's what makes M5 and M6 cheap and safe, and retrofitting an abstraction after
the core has grown around one provider is the standard way this design fails. That held — M5 and M6
landed against an unchanged suite.

**Next, in rough order of value:** point `roles:` at real models and run `kalee eval sweep` to get
the first quality-per-dollar numbers; a live `kalee doctor` pass against Ollama and `mlx_lm.server`
so the local caps are measured rather than guessed; then the deferred layers — MCP tool discovery,
durable memory, and `sandbox-exec` behind `tools/exec.ts`.

---

## Verification

Status as of 2026-09-09: `bun test` → **172 pass, 1 skip, 0 fail** across 13 files;
`tsc --noEmit` clean. The one skip is the live cache-regression test, which is gated behind
`KALEE_LIVE_CACHE=1` because it costs real Anthropic tokens. Everything below marked ✅ is
automated and green; the unmarked items need a live backend and have not been exercised yet.

- ✅ `test/conformance.test.ts` · `test/shim.test.ts` · `test/loop.test.ts` · `test/pipeline.test.ts`
  · `test/target.test.ts` · `test/git-tools.test.ts` · `test/jail.test.ts` · `test/exec.test.ts` ·
  `test/chunking.test.ts` · `test/roots.test.ts` · `test/repl.test.ts` · `test/core.test.ts`,
  against `test/fake-server.ts` rather than live providers.
- ⏳ Not yet run live: the cache-read assertion (`KALEE_LIVE_CACHE=1`), `kalee doctor` against a real
  Ollama/MLX endpoint, and `kalee eval run` / `sweep` for actual recall-precision numbers. Until the
  sweep runs, the quality gate below is defined but not enforcing.

- **Provider conformance suite** (the important one): one battery every adapter must pass — streams
  text deltas; emits a well-formed tool call; round-trips a tool result; reports usage; surfaces
  errors as typed failures rather than throwing raw; replays reasoning on same-model turns and drops
  it cross-model; survives an SSE frame split mid-JSON. New adapter = implement the interface, run
  the suite. Runs against recorded fixtures in CI, live on demand.
- **Shim tests:** feed a canned prose stream containing a `<tool_call>` block split across chunk
  boundaries and assert the emitted `Event`s are byte-identical to the native path's.
- **Unit** (`bun test`): `Target` resolution against a temp git repo built in the test; path-jail
  escapes (`../`, symlinks, absolute paths); bash timeout killing the entire process group.
- **Type-level:** `assertNever` in every IR switch means `tsc --noEmit` fails if an adapter misses a
  new variant. Treat this as part of the test suite, not a lint.
- **Cache regression test:** two turns against Anthropic, asserting cache-read tokens > 0 on turn 2.
  Silent cache invalidators are invisible and expensive; only an assertion catches them.
- **End-to-end smoke:** `kalee review --base main --format json` in this repo once it has history;
  confirm every finding's `file:line` resolves to a real location.
- **Quality gate:** `kalee eval run` before and after any change to `skills/` or `prompts/`. Treat a
  recall or precision drop as a failing build — without this, prompt edits are unfalsifiable.
- **Cost sanity:** every run prints tokens and dollar cost from the trace.
