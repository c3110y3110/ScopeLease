# Coding Agent Context Metering

ScopeLease measures agent-visible evidence for coding agents. This document defines
what can be measured and what must not be mixed together.

## Measurement Surfaces

| Surface | Source | Use | Boundary |
| --- | --- | --- | --- |
| ScopeLease MCP context | `scopelease_get_context`, `state.mcpContextEvents` | Exact compact context returned by ScopeLease | Agent-visible ScopeLease context only |
| Hook/watcher payload | hooks, watcher summaries, `scopelease_measure` | Observed work payloads and lane evidence | Only what the host emits |
| Prompt-observed command input | `pair-run` command prompt files | Exact bytes passed to Codex/Claude command | Command invocation input, not hidden model usage |
| Command-reported tokens | Codex CLI output when parseable | Runtime command-level token proxy | Not provider billing |
| Provider usage | explicit `scopelease_record_usage` or proxy ingest | Optional billing-like record | Separate from default meter |

Provider billing is not part of the default ScopeLease patent/CHI evidence target.

## Pair Delta Rule

ScopeLease reports a reduction only from matched pairs:

```text
same workIntent
same pairId
same repository
same task
same agent family
C0 lane: no ScopeLease
C3 lane: ScopeLease full
```

Formula:

```text
default observed value n
scopelease observed value m
delta      = n - m
reduction  = (n - m) / n, only when n > m
overhead   = (m - n) / n, when m > n
```

If the pair is missing, invalid, or negative, keep it visible. Do not convert it
into a savings claim.

## Agent Conditions

| Condition | Meaning |
| --- | --- |
| `C0` | Baseline Codex/Claude run without ScopeLease instructions, MCP, hook, scoped workspace, or lease. |
| `C1` | Context-only run with ScopeLease decision card and read/review frontier, but no guard or lease. |
| `C2` | Guard-only run with ScopeLease guard/hook behavior, but no context card or reusable signed lease. |
| `C3` | Full ScopeLease run with graph frontier, compact context, guard, signed lease, stop frontier, and metering. |

The default lane is not a synthetic full-repository prompt. It is the actual
agent run without ScopeLease under the same task.

## Fresh Run Commands

Codex:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node scripts/run-formal-command-eval.mjs \
  --repos-file examples/evaluation/formal-command-repos.example.json \
  --tasks examples/evaluation/official-fresh-run-tasks.example.jsonl \
  --agent-preset codex \
  --run-both-lanes \
  --scopelease-workspace-mode scoped \
  --workspace-scope-source auto \
  --scopelease-preapprove \
  --claim-metric command-reported \
  --min-repos 10 \
  --min-pairs 100
```

Claude:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node scripts/run-formal-command-eval.mjs \
  --repos-file examples/evaluation/formal-command-repos.example.json \
  --tasks examples/evaluation/official-fresh-run-tasks.example.jsonl \
  --agent-preset claude \
  --run-both-lanes \
  --scopelease-workspace-mode scoped \
  --workspace-scope-source auto \
  --scopelease-preapprove \
  --claim-metric prompt-observed \
  --min-repos 10 \
  --min-pairs 100
```

Use the generated run artifacts and
`examples/evaluation/fresh-run-snapshot.schema.json` for any report-grade
claim.

## Reporting Language

Safe:

> Under a named fresh-run protocol, ScopeLease compared C0 baseline and C3 full ScopeLease
> same-work-intent pairs and reported the observed delta for the stated metric
> boundary.

Unsafe:

> ScopeLease reduces provider cost by X%.

Unsafe unless provider usage was explicitly captured for both lanes:

> ScopeLease reduced billing tokens by X%.

## Product Boundary

ScopeLease can prove what it provided, what hooks/wrappers observed, and what the
agent command reported. It cannot see hidden prompts, hidden reasoning, cache
effects, or provider invoices unless those are explicitly ingested.
