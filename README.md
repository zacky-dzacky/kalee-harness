# Kalee Harness

A model-agnostic agent harness with one capability: **code review**.

```
$ kalee review --base main

2 findings — main...HEAD

high correctness  ✓ confirmed
src/session/store.ts:142
  `lastPageIndex` returns -1 for an empty collection, so the loop below never runs.
  When a user has no sessions, summarize() returns an empty string instead of
  "0 sessions", and the caller renders a blank panel.

medium concurrency  ? plausible
src/cache/warm.ts:38
  cache.has() is checked before an await, so concurrent callers all miss.
  Ten simultaneous requests for the same key each invoke the loader, which
  makes ten upstream calls where the cache was meant to make one.

────────────────────────────────────────────────────────────
opus-5 → haiku-4-5 · 24.1k in / 1.8k out (18.2k cached) · $0.0412 · 31.4s
```

Review was chosen as the first capability deliberately. It needs **only read-only tools**, so
the sandbox layer is trivially safe, and it needs **multi-pass orchestration** (scan → verify),
which forces the agent loop and orchestration layers to be real rather than decorative.

---

## Install

You need [Bun](https://bun.sh). If you don't have it:

```sh
curl -fsSL https://bun.sh/install | bash
exec $SHELL          # pick up the new PATH
```

### Option 1 — standalone binary (recommended)

```sh
git clone https://github.com/zacky-dzacky/kalee-harness.git
cd kalee-harness
./scripts/install.sh
```

That compiles a single binary to `~/.local/bin/kalee` and installs the runtime data
(`prompts/`, `skills/`, `models.yaml`) to `~/.kalee`. Override either location:

```sh
BIN_DIR=/usr/local/bin KALEE_DATA=~/kalee-data ./scripts/install.sh
```

Re-running the script upgrades the binary and prompts but **keeps your `models.yaml`**, since
`kalee doctor` writes probed capabilities back into it.

If `~/.local/bin` isn't on your PATH, add it to `~/.zshrc`:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

### Option 2 — run from source

Best if you're editing prompts or adding a provider: `kalee` points straight at the working
tree, so changes take effect on the next run with no rebuild.

```sh
git clone https://github.com/zacky-dzacky/kalee-harness.git
cd kalee-harness
bun install
bun link              # puts `kalee` in ~/.bun/bin
```

Or skip the global command entirely and use `bun run src/cli.ts <args>`.

### Check it worked

```sh
kalee models          # lists the registry and resolved capabilities
```

### Set a key

```sh
export ANTHROPIC_API_KEY=...      # default models are Claude
# or OPENAI_API_KEY / GEMINI_API_KEY, depending on which model you point a role at
```

Local models need no key at all — see [Local models](#local-models).

---

## Use

```sh
kalee review                      # working tree vs HEAD
kalee review --staged             # staged changes only
kalee review --base main          # merge-base(main, HEAD)..HEAD
kalee review 1234                 # GitHub PR, via the gh CLI
kalee review src/auth/            # a path — no diff signal, so a different prompt
```

Useful flags:

| Flag | Effect |
|---|---|
| `--model <id>` | one model for every role |
| `--role-model scan=opus-5,verify=haiku-4-5` | a different model per pass |
| `--effort low\|medium\|high\|max` | reasoning effort, where the backend has a knob |
| `--format terminal\|json\|markdown` | `json` and `markdown` print to stdout, progress to stderr |
| `--no-verify` | skip the verification pass — faster, noisier |
| `--comment` | post findings as inline PR comments (PR target only, asks first) |
| `--permission-mode readonly\|ask\|auto\|deny` | `readonly` is the default and is all review needs |
| `--max-cost 0.50` | stop the run at a dollar cap |

`kalee review` **exits non-zero when any finding is confirmed**, so CI can gate on it:

```yaml
- run: kalee review --base ${{ github.base_ref }} --format markdown >> $GITHUB_STEP_SUMMARY
```

Other commands:

```sh
kalee ask "which files handle auth?"    # raw harness access — proves the core is general
kalee models                            # registry + resolved capabilities
kalee doctor local-qwen7b               # probe a backend, write real caps back to models.yaml
kalee eval run                          # score recall/precision against the fixtures
kalee eval sweep --models opus-5,gpt-5  # the same fixtures across backends: quality per dollar
kalee trace <session-id>                # replay a run: turns, tools, cost, latency
```

---

## How review works

Two passes, and the second one is the point.

**Scan** runs the agent loop over the diff with read-only tools, reporting candidates through a
schema that *requires* a concrete failure scenario. If a claim can't name inputs that lead to a
wrong result, it isn't a finding.

**Verify** re-checks each candidate in a **fresh, isolated context** — a different model, if you
want one — asking only: here is the claim, read the actual code, does it hold? Verdicts are
`confirmed`, `plausible`, or `rejected`; rejected findings are dropped before you ever see them.

The verify pass is the single biggest precision lever, and it's why review was the right first
capability: it exercises sub-agent orchestration, handoff state, and per-role model routing
without needing a single write tool.

Per-role models fall out of that and are genuinely useful — a strong model to find things,
a cheap one to check them:

```yaml
# models.yaml
roles:
  scan:   opus-5
  verify: haiku-4-5
```

---

## Local models

The OpenAI adapter plus a `baseURL` override covers Ollama, MLX, LM Studio, vLLM, llama.cpp,
OpenRouter, Groq, Together, DeepSeek, Mistral and xAI. So a local review is a registry entry:

```yaml
- id: local-qwen7b
  provider: openai
  baseURL: http://localhost:11434/v1     # Ollama
  apiModel: qwen2.5:7b
  pricing: { input: 0, output: 0 }
  caps: { nativeToolCalls: true, maxContext: 32768, ... }
```

```sh
kalee review --model local-qwen7b
```

Two things make this real rather than aspirational:

**Capabilities are probed, not declared.** They vary per *model*, not per provider — two models
behind the same Ollama endpoint can differ on tool calling. `kalee doctor <id>` runs a short
battery and writes what it found back into `models.yaml`.

**Models with no native tool calling still work.** Many local models — `mlx_lm.server` in
particular, where tool support depends entirely on the model's chat template — describe a call
in prose instead of emitting structured `tool_calls`. Set `nativeToolCalls: false` and the shim
renders the schemas into the system prompt, parses the text stream for them (buffering across
chunk boundaries, so a tag split mid-token doesn't leak into visible output), and emits real
tool-call events. The agent loop cannot tell the difference.

**Small context windows degrade instead of failing.** A 60k-token diff won't fit a 32k model, so
the scan pass splits into per-file passes rather than erroring.

---

## Adding a provider

1. Implement `ModelProvider` from `src/model/provider.ts`.
2. Add it to the switch in `src/providers/index.ts`.
3. Add three lines to `test/conformance.test.ts`.

The conformance suite is one battery every adapter must pass: streams text deltas, emits a
well-formed tool call, round-trips a tool result, reports usage, surfaces errors as typed
failures, drops reasoning from a different model, survives an SSE frame split mid-JSON. It runs
offline against a local server that speaks all three wire formats, so it exercises real adapter
code rather than a mock.

It was built at milestone 1 rather than last, deliberately — that's what makes a third and
fourth wire format cheap, and retrofitting the abstraction later is the standard way this design
fails. It earned its keep immediately by catching a tool-name doubling bug in the OpenAI adapter.

---

## Development

```sh
bun test              # 147 tests
bun run typecheck     # part of the test suite, not a lint — see below
bun run build         # single binary at dist/kalee
```

`tsc --noEmit` is load-bearing: every `switch` over the IR's `Block` and `Event` unions ends in
`assertNever`, so adding a variant fails compilation in *every* adapter rather than silently
no-oping in one.

**Run `kalee eval run` before and after any change to `skills/` or `prompts/`.** Treat a recall
or precision drop as a failing build. Without it, prompt edits are unfalsifiable — which is the
normal way a harness like this quietly gets worse. Two of the eight fixtures are clean diffs
that must produce **zero** findings, because a reviewer that flags everything scores perfect
recall.

`KALEE.md` holds the conventions for working in this codebase, and doubles as the project
identity overlay the agent reads at run time. `PLAN.md` is the original design; `LAYERS.md` is
the architecture it implements.
