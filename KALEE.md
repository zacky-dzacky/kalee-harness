# Kalee Harness

A model-agnostic agent harness with one capability: code review.

Review was chosen as the first capability deliberately. It needs **only read-only tools**, so
the sandbox layer is trivially safe in v1, and it needs **multi-pass orchestration**
(scan → verify), which forces the agent-loop and orchestration layers to be real rather than
decorative.

## Conventions for anyone (or anything) working in this repo

**Nothing above `src/providers/` may import a provider SDK type.** The IR in `src/model/ir.ts`
is the contract. If you find yourself reaching for an Anthropic or OpenAI type in `src/core/`,
the abstraction is wrong — fix the IR instead.

**Every `switch` over `Block` or `Event` ends in `assertNever`.** This is what makes adding an
IR variant fail compilation in every adapter rather than silently no-op in one. Treat
`tsc --noEmit` as part of the test suite, not a lint.

**Prompts and the registry are runtime data.** `prompts/`, `skills/` and `models.yaml` are read
from disk at run time and never bundled as constants. Prompt iteration is where most of the
real work happens; it must not require a rebuild.

**Stable content before volatile content.** `ContextBuilder` enforces this, because the failure
mode — a prompt prefix that changes every run, so the cache silently never hits — costs money
and produces no error. Never work around the builder's ordering check.

**Capabilities are probed, not declared.** `caps` in `models.yaml` for a local backend is a
guess until `kalee doctor <model>` has run. Two models behind the same Ollama endpoint can
differ on tool calling.

## Layer → module map

| `LAYERS.md` box | Module | v1 |
|---|---|---|
| Durable identity | `prompts/identity.md` + `core/identity.ts` | ✅ |
| Loadable skills | `core/skills.ts` | ✅ |
| Compiled context | `core/context.ts` | ✅ |
| Adaptation limits | `core/budget.ts` | ✅ |
| Sandbox runtime / Resource bounds / OS permissions | `tools/exec.ts` | partial |
| Code substrate | — | later |
| Tool schema / Protocol / Discovery / Routing | `tools/` + zod schemas | ✅ (MCP later) |
| Active context / Session state / Durable memory | `core/session.ts` | ✅ (memory later) |
| Agent loop / Multi-agent / Handoff / Task pipeline | `core/loop.ts` + `review/pipeline.ts` | ✅ |
| Caching & compression | `CacheSpan` + `core/compact.ts` | ✅ (learned routing later) |
| Benchmark grounding / Readiness / Regression | `src/eval/` | ✅ |
| Execution traces / Cost & latency / Failure attribution | `core/trace.ts` | ✅ |
| Permission control / Policy / Audit / Guardrails | `core/policy.ts` | ✅ |

## Commands

```
kalee review                          # working tree vs HEAD
kalee review --staged
kalee review --base main              # merge-base(main, HEAD)..HEAD
kalee review 1234                     # GitHub PR via gh
kalee review src/auth/                # path mode (no diff signal — different prompt)
  --model <id> | --role-model scan=<id>,verify=<id>
  --effort low|medium|high|max
  --format terminal|json|markdown
  --no-verify                         # skip the verification pass
  --comment                           # inline PR comments (PR target only)
  --permission-mode readonly|ask|auto|deny
kalee models                          # registry + resolved capabilities
kalee doctor <model>                  # probe a backend, write caps back to models.yaml
kalee ask "<prompt>"                  # raw harness access — proves the core is general
kalee eval run | sweep | list
kalee trace <session-id>
```

`kalee review` exits non-zero when any finding is `confirmed`, so CI can gate on it.

## Quality gate

Run `kalee eval run` before and after **any** change to `skills/` or `prompts/`. Treat a recall
or precision drop as a failing build. Without this, prompt edits are unfalsifiable — which is
the normal way a harness like this quietly gets worse.

Two of the eight fixtures are clean diffs that must produce **zero** findings. They are there
because a reviewer that flags everything scores perfect recall.

## Setup

See [README.md](README.md) for installation. In short: `./scripts/install.sh` for a standalone
binary, or `bun install && bun link` to run from source.

Local backends need no key: start Ollama or `mlx_lm.server`, then `kalee doctor <model>` to
record what that model can actually do.
