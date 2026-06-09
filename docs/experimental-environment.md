# Experimental Environment

This document defines the environment for patent and CHI-oriented fresh runs. It intentionally avoids older run ids and older averages.

## Fixed Snapshot

Create one directory per formal run:

```text
.scopelease/experiments/formal-fresh-<agent>-YYYYMMDD-HHMMSS/
  manifest.json
  run-log.json
  product-wide-summary.json
  claim-report.stdout.json
  final-status.json
  logs/
```

Each benchmark repository should also keep its lane artifacts under:

```text
<repo>/.scopelease/experiments/<run-id>/
  summary.json
  pairs.jsonl
  events.jsonl
  <task>/<repetition>/<lane>/prompt.md
  <task>/<repetition>/<lane>/context.json
```

## Machine And Runtime

Record:

- macOS version and CPU/GPU
- Node version
- npm version
- ScopeLease source archive/hash
- `package-lock.json`
- Codex CLI/app version if available
- Claude Code CLI/app version if available
- benchmark dataset version or task source URL
- whether network is disabled, allowed, or task-required
- explicit timeout configuration per lane, if any; paper scripts default to no implicit command/repo timeout

The user's Codex and Claude paid plans may be used for command execution, but the experiment does not claim provider billing savings unless provider usage is explicitly recorded for both lanes with `lane`, `pairId`, `runId`, and `workIntent`.

## C0-C3 Live Conditions

| Condition | Description |
| --- | --- |
| C0 baseline | Agent command/app receives the task prompt in an isolated copied worktree without ScopeLease MCP, ScopeLease hooks, ScopeLease prompt, or signed lease |
| C1 context only | Agent receives the ScopeLease decision card, read frontier, and review frontier; guard, hook, and signed lease are disabled |
| C2 guard only | Agent is routed through ScopeLease guard or hook; ScopeLease context card and reusable signed lease are disabled |
| C3 full ScopeLease | Agent receives context card, review frontier, guard, signed lease, stop frontier, and metering |

Run these conditions separately for Codex and Claude. Do not mix Codex/Claude rows in the same pair id.

## Current Local Benchmark Status

As of 2026-05-31, prompt-integrated Terminal-Bench C1/C2/C3 runs have been removed from source-of-truth evidence. They changed the benchmark task prompt, so they are not valid evidence for ScopeLease behavior or token savings.

Status:

| Benchmark | Current status | Blocking / boundary |
| --- | --- | --- |
| Terminal-Bench | Same-prompt connected C0-C3 selected panel completed on 2026-05-31 and expanded on 2026-06-01; 2026-06-03 refresh is partial only | Complete selected panel is 12 tasks; partial refresh currently has 2 completed tasks and does not replace the complete panel |
| SWE Atlas | Repository pinned and inspected, not executed | `harbor` and `modal` missing; judge variables such as `EVAL_BASE_URL`/`EVAL_MODEL` not configured |
| SWE-bench | Repository pinned and inspected, not executed | Python harness import currently fails on missing `ghapi`; no C0-C3 prediction runner wired |
| MLE-bench | Repository pinned and inspected, not executed | Python CLI import currently fails on missing `diskcache`; Kaggle credentials are absent; datasets are not prepared |

For Terminal-Bench, a claim-ready run must keep the original task prompt unchanged. Baseline same-prompt observation can use:

```bash
PYTHONPATH="$PWD/scripts/terminal-bench" \
CODEX_AUTH_JSON_B64="$(base64 < "$HOME/.codex/auth.json" | tr -d '\n')" \
tb run \
  --dataset-path "$PWD/.scopelease/benchmarks/terminal-bench/original-tasks" \
  --agent-import-path codex_oauth_observed_agent:CodexOauthObservedAgent \
  --run-id same-prompt-observed-YYYYMMDD
```

Then summarize it without treating the run as an ScopeLease behavior improvement:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js terminal-bench-summary \
  --run .scopelease/reports/<run>/tb-run/<run-id> \
  --format json
```

Current same-prompt smoke:

```text
run: .scopelease/reports/terminal-bench-same-prompt-observed-20260531/tbench-hello-same-prompt-20260531
task: hello-world
result: 1/1 resolved
Codex CLI command-reported tokens: 13,901
boundary: same_prompt_observed_run_not_scopelease_behavior_claim
```

Current same-prompt connected C0-C3 selected panel:

```text
run root: .scopelease/reports/terminal-bench-scopelease-c0c3-20260531/
summary: scopelease-terminal-bench-connected-c0c3-panel.json
tasks: hello-world, jsonl-aggregator, cpp-compatibility, regex-log, log-summary-date-ranges, simple-sheets-put, jq-data-processing, tree-directory-parser, heterogeneous-dates, assign-seats, openssl-selfsigned-cert, cancel-async-tasks
conditions: C0 baseline, C1 context-only, C2 guard/hooks-only, C3 full ScopeLease
prompt mutation: none
completion: C0 12/12, C1 11/12, C2 12/12, C3 12/12; 47/48 condition runs resolved
C0 command-reported tokens: 281,547
C1 command-reported tokens: 373,207
C2 command-reported tokens: 320,186
C3 command-reported tokens: 880,394
boundary: selected local public-benchmark panel; C3 preserves C0-level completion but shows overhead, not token savings
```

Current 2026-06-03/2026-06-06 refresh status:

```text
run root: .scopelease/reports/terminal-bench-scopelease-c0c3-20260603/
summary: scopelease-terminal-bench-connected-c0c3-panel.json
completed tasks: hello-world, jsonl-aggregator
conditions completed: 8/48 condition rows
completion: C0 2/2, C1 2/2, C2 2/2, C3 1/2
C0 command-reported tokens: 38,652
C1 command-reported tokens: 28,917
C2 command-reported tokens: 27,357
C3 command-reported tokens: 60,303
stopped row: cpp-compatibility C0 stalled and was terminated on 2026-06-06
boundary: partial rerun and runner-regression evidence only; do not use as replacement for the complete 2026-05-31 selected panel
```

The current runner adds an outer `--runner-timeout-sec` guard around `tb run`
and the repo includes `npm run paper:tbench:stop-scopelease-panel` for cleaning up
only the scoped ScopeLease Terminal-Bench panel processes under the configured output
root.

The selected panel includes `simple-sheets-put`, which requires the task-local service `http://api:8000`. C3 now allows that exact internal origin only through `allow_task_scoped_network`; external network access remains blocked. The expanded panel also includes certificate generation, constraint solving, and async implementation tasks. The only unresolved row is `cancel-async-tasks` under C1 context-only.

Connected C0-C3 command template:

```bash
PYTHONPATH="$PWD/scripts/terminal-bench" \
CODEX_AUTH_JSON_B64="$(base64 < "$HOME/.codex/auth.json" | tr -d '\n')" \
tb run \
  --dataset-path "$PWD/.scopelease/benchmarks/terminal-bench/original-tasks" \
  --task-id hello-world \
  --agent-import-path codex_oauth_scopelease_agent:CodexOauthScopeLeaseAgent \
  --model openai/gpt-5.5 \
  --agent-kwarg version=latest \
  --agent-kwarg condition=C3 \
  --output-path .scopelease/reports/terminal-bench-scopelease-c0c3-YYYYMMDD \
  --run-id tbench-hello-c3-YYYYMMDD \
  --n-concurrent 1 \
  --n-attempts 1 \
  --global-agent-timeout-sec 300 \
  --global-test-timeout-sec 180 \
  --no-upload-results
```

Current live Codex lean same-workIntent pilot:

```text
run: .scopelease/experiments/pilot-codex-main-20260607
generated: 2026-06-07
repo: scopelease-paper
agent/model: Codex CLI command adapter
pairs: 4
lane commands: 8/8 passed
lane timeouts: 0
command-reported total tokens: 370,894 -> 281,438
weighted command delta: 24% lower
macro command delta: 20% lower
median command delta: 28% lower
positive / overhead command pairs: 3 / 1
decision-prompt proxy: 456 -> 4, 99% lower
duration proxy: 363,047ms -> 339,612ms, 6% lower
task-specific completion rubric: not configured
boundary: local one-repository pilot; validates runner and measurement path but is not a 10-repository/100-pair report-grade average
```

Current live Claude lean same-workIntent pilot:

```text
run: .scopelease/experiments/pilot-claude-main-20260607
generated: 2026-06-07
repo: scopelease-paper
agent/model: Claude CLI command adapter
pairs: 4
lane commands: 8/8 passed
lane timeouts: 0
command-reported source: claude_cli_json_usage
command-reported total tokens: 2,304,719 -> 1,674,373
weighted command delta: 27% lower
macro command delta: 22% lower
median command delta: 37.5% lower
positive / overhead command pairs: 3 / 1
decision-prompt proxy: 456 -> 4, 99% lower
duration proxy: 632,181ms -> 426,178ms, 33% lower
heuristic command-quality: 4/4 pairs, score 100%
task-specific completion rubric: not configured
boundary: local one-repository pilot; validates runner, local Claude binary resolution, and measurement path but is not a 10-repository/100-pair report-grade average
```

Previous live Codex MCP same-workIntent pilot:

```text
run: .scopelease/experiments/chi-live-mcp-pilot-final-20260601
repo: scopelease-paper
agent/model: Codex CLI command adapter
pairs: 4
ScopeLease MCP context imported: 4/4 pairs
strict agent-visible input: 418 -> 2,284, 446% higher
command-reported total tokens: 274,355 -> 248,858
weighted command delta: 9% lower
macro command delta: 10% higher
positive / overhead command pairs: 2 / 2
boundary: local MCP pilot only; mixed distribution, not a 10-repository/100-pair report-grade average savings claim
```

Current formal fresh dry-run status:

```text
script: npm run paper:formal:fresh:dry-run
manifest: examples/evaluation/official-fresh-run-tasks.example.jsonl
configured repos: 1
expected pairs: 8
required threshold: minRepos 10, minPairs 100
status: not ready for formal main run until the repo manifest and task/repeat plan satisfy the threshold
```

Formal local main protocol:

```text
script: npm run paper:formal:local-main
dry run: npm run paper:formal:local-main:dry-run
manifest: .scopelease/evaluation/formal-live-local-repos.json
configured repos: 10
expected pairs: 160
run id prefix: formal-local-main-codex
status: superseded by the resource-bounded formal local main. The 2026-06-07 unbounded Codex attempt failed on `ai-research-os` with Node heap OOM after about 529s and was operator-stopped during the following `ai-survey-os` run; it is retained only as resource-failure history.
```

Formal local main Claude replication protocol:

```text
script: npm run paper:formal:local-main:claude
dry run: npm run paper:formal:local-main:claude:dry-run
manifest: .scopelease/evaluation/formal-live-local-repos.json
configured repos: 10
expected pairs: 160
run id prefix: formal-local-main-claude
status: superseded by the resource-bounded Claude formal local main, which completed on 2026-06-08.
```

Formal local main failed attempt and retry requirement:

```text
attempt: npm run paper:formal:local-main
date: 2026-06-07
timeout policy: no implicit repo or command timeout
first failure: ai-research-os failed with Node heap OOM
stderr: .scopelease/experiments/formal-local-main-codex/logs/formal-local-main-codex-ai-research-os.stderr.log
follow-up state: ai-survey-os continued running and was operator-stopped with npm run paper:formal:stop-local-main
formal evidence status: not collected; no wrapper run-log.json or final-status.json was written
```

The current result-bearing broad local main uses a preregistered resource-
bounded manifest with documented inclusion/exclusion criteria. It writes
auditable per-repo progress and final status artifacts.

Resource-bounded formal local main results:

```text
manifest: .scopelease/evaluation/formal-live-local-repos-resource-bounded.json
timeout policy: no implicit repo or command timeout
codex run: npm run paper:formal:local-main:resource-bounded
codex output: .scopelease/experiments/formal-local-main-codex-resource-bounded
codex result: 11 repos, 176 pairs, 11,830,597 -> 3,879,686 command-reported tokens, 67% weighted lower
claude run: npm run paper:formal:local-main:claude:resource-bounded
claude output: .scopelease/experiments/formal-local-main-claude-resource-bounded
claude result: 11 repos, 176 pairs, 49,656,538 -> 21,824,362 command-reported tokens, 56% weighted lower
claim boundary: C0/C3 command-reported protocol only; not provider billing and not four-condition C0-C3
```

Required non-human main experiments:

- Live four-condition C0-C3 agent trajectory main, only if making four-condition trajectory claims: run the same task snapshots across C0/C1/C2/C3 over the resource-bounded local manifest or a preregistered public task set. Report completion/verifier outcomes, command-reported tokens, agent-visible context when available, file/tool calls, guard/lease events, review-frontier size and recall, silent failures, unsafe calls, retries, duration, and operator stops.
- Selected public benchmark extension: keep Terminal-Bench, SWE Atlas/SWE-bench-style, and MLE-style families separated. Do not mutate task prompts. Scope task-required internal APIs explicitly and report completion separately from token or overhead metrics.
- Optional replication: repeat the same C0-C3 protocol with a second agent/model only as a separately labeled replication, not as a mixed aggregate.

## Required Commands

Prepare a repo list outside source control:

```json
{
  "repos": [
    { "label": "repo-a", "path": "/absolute/path/to/repo-a", "include": true },
    { "label": "repo-b", "path": "/absolute/path/to/repo-b", "include": true }
  ]
}
```

Attach a repository before interactive use:

```bash
node src/cli.js init /path/to/repo
node src/cli.js attach /path/to/repo
node src/cli.js app /path/to/repo --open
```

Artifact and pilot npm wrappers:

```bash
npm run paper:tbench:scopelease-panel:dry-run
npm run paper:tbench:scopelease-panel
npm run paper:tbench:stop-scopelease-panel
npm run paper:live-pilot:dry-run
npm run paper:live-pilot
npm run paper:formal:discover-repos
npm run paper:formal:local-main:dry-run
npm run paper:formal:local-main
npm run paper:formal:stop-local-main
npm run paper:formal:fresh:dry-run
npm run paper:human-study
```

Run a small Codex pilot before the main protocol:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node scripts/run-formal-command-eval.mjs \
  --repos-file .scopelease/evaluation/fresh-run-repos.json \
  --tasks examples/evaluation/live-pilot-tasks.jsonl \
  --repeat 1 \
  --min-repos 1 \
  --min-pairs 4 \
  --default-agent codex \
  --scopelease-agent codex \
  --live-observed-command-mode lean \
  --run-id-prefix pilot-codex-YYYYMMDD-HHMMSS
```

The pilot must be interpreted as a check that the command runner, lane pairing, token parser, quality heuristic, and claim-report pipeline work on the local machine. It is not the final CHI evidence unless the configured threshold is raised to the formal protocol target and satisfied.

For MCP-context connection checks, use the direct pair-run form so the ScopeLease lane must call `scopelease_get_context` at the start:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js pair-run . \
  --tasks examples/evaluation/live-pilot-tasks.jsonl \
  --repeat 1 \
  --default-agent codex \
  --scopelease-agent codex \
  --live-observed \
  --copy-worktree \
  --scopelease-workspace-mode scoped \
  --workspace-scope-source auto \
  --live-observed-command-mode mcp \
  --agent-sandbox workspace-write \
  --run-id chi-live-mcp-pilot-YYYYMMDD \
  --output .scopelease/experiments/chi-live-mcp-pilot-YYYYMMDD \
  --format json
```

Run a Codex fresh protocol:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node scripts/run-formal-command-eval.mjs \
  --repos-file .scopelease/evaluation/fresh-run-repos.json \
  --tasks examples/evaluation/official-fresh-run-tasks.example.jsonl \
  --repeat 2 \
  --min-repos 10 \
  --min-pairs 100 \
  --default-agent codex \
  --scopelease-agent codex \
  --live-observed-command-mode lean \
  --run-id-prefix formal-fresh-codex-YYYYMMDD-HHMMSS
```

Run a Claude fresh protocol:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node scripts/run-formal-command-eval.mjs \
  --repos-file .scopelease/evaluation/fresh-run-repos.json \
  --tasks examples/evaluation/official-fresh-run-tasks.example.jsonl \
  --repeat 2 \
  --min-repos 10 \
  --min-pairs 100 \
  --default-agent claude \
  --scopelease-agent claude \
  --live-observed-command-mode lean \
  --run-id-prefix formal-fresh-claude-YYYYMMDD-HHMMSS
```

## What Counts As Evidence

Claim-ready:

- command-reported total tokens from both lanes
- prompt bytes supplied to the agent command
- same pair id and work intent
- same repo snapshot
- task verifier pass/fail
- guard/lease/enforce events
- review-frontier quality result

Diagnostic only:

- full repository size
- readPlan file count without command run
- one-repository/four-pair pilots when making report-grade average claims
- auto-promoted same-run pairs
- incomplete hook/MCP candidates
- provider billing without lane pairing

## Required Report Sections

1. Source and benchmark snapshot.
2. Task family distribution.
3. Completion result.
4. Context/call/duration deltas.
5. Permission/delegation correctness.
6. Decision prompt proxy.
7. Review-frontier quality.
8. Failure modes and overhead pairs.
9. Human study result, when run.
10. Patent claim boundary and CHI contribution boundary.
# Experimental Environment Addendum (2026-06-07)

The current formal live setup uses two agent backends: Codex CLI and Claude CLI.
Provider/API proxy metering is not required for the normal ScopeLease evidence
package; command-reported CLI usage and ScopeLease-observed events are the evidence
sources currently in scope.

Non-human environment status:

- Codex CLI one-repository pilot: completed and documented as bounded pilot
  evidence.
- Claude CLI one-repository pilot: completed and documented as bounded pilot
  evidence.
- Current CLI availability: `command -v codex` resolves to
  `/usr/local/bin/codex` and `codex --version` reports `codex-cli 0.137.0`.
  Claude is resolved by the harness through its local install search path for
  the completed resource-bounded main run.
- Original broad Codex local main: attempted, then stopped after the first
  oversized repository hit Node heap OOM. It is not used as a result claim.
- Resource-bounded formal main manifest:
  `.scopelease/evaluation/formal-live-local-repos-resource-bounded.json`.
- Resource-bounded repository gate: max search depth 8, max shallow file count
  2000, virtualenv and `site-packages` excluded, current `scopelease_paper` and copied
  agent worktrees excluded, duplicate labels de-duplicated.
- Resource-bounded dry-run status: Codex and Claude both pass with 11
  repositories and 176 expected pairs per agent.
- Resource-bounded non-dry-run status: Codex and Claude both complete with 11
  repositories and 176 measured pairs per agent.
- Timeout policy: dry-runs report `repoTimeoutMs: 0` and `commandTimeoutMs: 0`.
  The current formal protocol does not encode a 300,000 ms command timeout.

Use the dry-run commands as protocol checks:

```bash
npm run paper:formal:discover-repos:resource-bounded
npm run paper:formal:local-main:resource-bounded:dry-run
npm run paper:formal:local-main:claude:resource-bounded:dry-run
```

Completed non-dry-run commands:

```bash
npm run paper:formal:local-main:resource-bounded
npm run paper:formal:local-main:claude:resource-bounded
```

These non-dry-run commands have finished and their product-wide summaries and
claim reports verify as command-reported C0/C3 protocol evidence.
