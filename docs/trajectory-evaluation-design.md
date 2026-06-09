# ScopeLease Trajectory Evaluation Design

This document is the current implementation-facing evaluation design. It replaces token-only wording with scoped-delegation evidence.

## What Is Being Evaluated

ScopeLease is evaluated as a delegation-control layer for coding agents:

> It turns a local approval prompt into a graph-scoped delegation contract that says what the agent may read, review, change, execute, and stop on.

Token or call reduction is one measured outcome. It is not the whole claim.

## C0-C3 Conditions

`condition-matrix` expands each task into four ablation conditions, and `ablation-run` computes the controlled manifest-level result for those conditions:

| Condition | Meaning | Purpose |
| --- | --- | --- |
| C0 | Baseline agent | Native Codex/Claude-style behavior without ScopeLease |
| C1 | ScopeLease context only | Separates graph-scoped context from scopeleaserity control |
| C2 | ScopeLease guard only | Separates action guard from reusable signed approval |
| C3 | ScopeLease full | Context, review frontier, permission frontier, signed lease, and stop frontier |

Design-only matrix:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js condition-matrix . \
  --tasks examples/evaluation/patent-paper-review-frontier-tasks.jsonl \
  --format json
```

The matrix is a design artifact. It is not result evidence until the same `taskId` and `workIntent` are run under comparable agent, model, budget, environment, and repeat settings.

Controlled result:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js ablation-run . \
  --tasks examples/evaluation/patent-paper-review-frontier-tasks.jsonl \
  --max-frontier-files 24 \
  --format json
```

`ablation-run` is result evidence only for `controlled_task_manifest_ablation_not_live_agent_execution`. The current source-of-truth fixes `--max-frontier-files 24` as the review-card budget before live/official benchmark runs. It decomposes context/review, guard, signed-lease, and stop-frontier effects on the frozen task manifest. It is still not a live Codex/Claude or official benchmark run.

## Current Public Benchmark Rule

The previous Terminal-Bench prompt-integrated C1/C2/C3 runs have been removed from source-of-truth evidence. They changed the benchmark task prompt by prepending ScopeLease delegation text, so the result mixed three effects:

- the original benchmark task,
- extra ScopeLease prompt text,
- agent behavior changes caused by the extra text.

Those runs are not claim-ready and must not be used for CHI or patent result tables.

The replacement rule is:

> Official/public benchmark runs must keep the benchmark task prompt identical across conditions. ScopeLease may be attached through host-side hooks/enforcement, `guarded-exec`, MCP/context logging, or post-hoc trajectory parsing, but behavior claims require a real connected enforcement/context path rather than prompt mutation.

Current implementation support:

| Capability | Status | Boundary |
| --- | --- | --- |
| Same-prompt Terminal-Bench observed run parsing | Implemented via `terminal-bench-summary` | Completion and Codex CLI `tokens used` only |
| Host-side ScopeLease connection in Terminal-Bench | Implemented for selected panel via `codex_oauth_scopelease_agent.py` | C1/C2/C3 attach MCP/hooks/AGENTS without mutating the task prompt |
| Prompt-integrated Terminal-Bench C1/C2/C3 | Removed from source-of-truth evidence | Diagnostic only if rerun separately and clearly labeled |

Current same-prompt smoke evidence:

```text
Terminal-Bench hello-world
run: .scopelease/reports/terminal-bench-same-prompt-observed-20260531/tbench-hello-same-prompt-20260531
resolved: 1/1
command-reported tokens: 13,901
interpretation: public-task execution and token observation only
```

Current same-prompt connected C0-C3 panel:

```text
run root: .scopelease/reports/terminal-bench-scopelease-c0c3-20260531/
summary: scopelease-terminal-bench-connected-c0c3-panel.json
tasks: hello-world, jsonl-aggregator, cpp-compatibility, regex-log, log-summary-date-ranges, simple-sheets-put, jq-data-processing, tree-directory-parser, heterogeneous-dates, assign-seats, openssl-selfsigned-cert, cancel-async-tasks
completion: C0 12/12, C1 11/12, C2 12/12, C3 12/12; 47/48 selected condition runs resolved
C0 tokens: 281,547
C1 tokens: 373,207
C2 tokens: 320,186
C3 tokens: 880,394
interpretation: connection/completion evidence; C3 preserves C0-level completion but has substantial overhead, not a token-saving result
```

The panel includes a task-required internal API case (`simple-sheets-put`). The C3 path uses an explicit task-scoped network lease for the prompt-declared `http://api:8000` origin and continues to deny external network access. The only unresolved row in the expanded panel is `cancel-async-tasks` under C1 context-only.

Current live Codex MCP pilot evidence:

```text
run: .scopelease/experiments/chi-live-mcp-pilot-final-20260601
condition scope: paired C0/C3-like local command protocol, not official benchmark C0-C3
pairs: 4
ScopeLease MCP context imported: 4/4 pairs
strict agent-visible input: 418 -> 2,284, 446% higher
command-reported total tokens: 274,355 -> 248,858
weighted command delta: 9% lower
macro command delta: 10% higher
positive / overhead command pairs: 2 / 2
interpretation: same-workIntent command runner, MCP import, and token parser are working; this mixed pilot does not support an average savings claim
```

Same-prompt observed summary command:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js terminal-bench-summary \
  --run .scopelease/reports/<run>/tb-run/<run-id> \
  --condition C0 \
  --format json
```

## Trajectory Metrics

The implementation records or derives trajectory events for:

| Axis | What It Measures |
| --- | --- |
| Task success | completion, tests, command quality, non-inferiority |
| Context/call reduction | agent-visible tokens, command-reported total tokens, file/tool-call proxy |
| Permission delegation | allow/ask/deny, false allow/block, lease hit, stop condition |
| Review completeness | critical file recall, precision, candidate surface reduction |
| Leakage | forbidden/private/generated/local state entering prompt or review frontier |
| Merge boundary | baseline/graph scope mismatch and stale state |
| Intent consistency | expected guard verdict, action grant, and task purpose alignment |
| Human supervision | participant study metrics only; not claimed from logs |

These are intentionally separate. A high token saving is not claim-ready if omission, leakage, merge drift, or intent drift increases.

## Delegation Report

`delegation-report` combines:

- C0-C3 condition design
- controlled C0-C3 ablation result
- review-frontier benchmark
- latest permission fixture summary, when available
- product-wide observed/command token summaries
- silent-failure trajectory metrics
- claim-safe wording rules

Run:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js delegation-report . \
  --tasks examples/evaluation/patent-paper-review-frontier-tasks.jsonl \
  --max-frontier-files 24 \
  --format json
```

It writes:

```text
.scopelease/reports/delegation-control-*/delegation-control-report.json
.scopelease/reports/delegation-control-*/delegation-control-report.md
```

## Token/Call Claim Boundary

The report keeps three token/call sources separate:

| Source | Can Support |
| --- | --- |
| Observed agent-visible pairs | Same-workIntent prompt/input delta, not provider billing |
| Command-reported total tokens | Named CLI/agent protocol delta, not provider billing |
| Review file-read proxy | Candidate file/tool-call reduction, not actual natural Codex usage |
| Same-prompt Terminal-Bench observed run | Public-task completion and Codex CLI token observation, not ScopeLease behavior causality |
| Same-prompt connected Terminal-Bench C0-C3 panel | Public-task completion under attached ScopeLease sidecar/hooks and command-reported overhead/savings, not provider billing |
| Latest live Codex MCP pilot | Local runner feasibility, MCP import, and paired command-reported/agent-visible measurement; mixed distribution, not report-grade generalization |

Do not merge these into one headline number. Negative deltas and overhead pairs must remain visible.

## Patent Use

For patent drafting, the strongest implemented mechanism is:

> repo-local graph + baseline diff + read/review/permission/stop frontiers + action-specific HMAC-signed approval lease + subsequent lease validation.

The trajectory report is evidence that this mechanism is tied to concrete evaluation axes, not just UI wording.

## CHI Use

For CHI, the automated report is Study 1 only:

- It can support claims about agent trajectory and boundary preservation.
- It cannot prove workload, fatigue, trust, perceived control, or human decision accuracy.
- Those claims require a participant study using the existing `human-study` export.
