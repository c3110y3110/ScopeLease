# Current Research Memory

Date: 2026-06-08

This is the current source-of-truth note for patent and CHI framing. Older run-number documents should not be used as current evidence unless a fresh snapshot regenerates them under the protocol below.

## Current Invention Framing

ScopeLease is a sidecar for coding agents. It is not the main coding application, not a provider-billing meter, and not a universal sandbox.

The implemented technical contribution is:

> repo-local graph and baseline diff create compact context and review frontiers; normalized agent actions are evaluated by a guard; a user-approved scope becomes an HMAC-signed approval lease; later actions are checked against request, baseline, risk, file scope, command scope, stop condition, graph boundary, and signature; paired metering records whether the same work intent used fewer observed agent-visible tokens or command-reported tokens.

## Implemented Claim Axes

| Axis | What ScopeLease Measures | Current Status |
| --- | --- | --- |
| Context boundary | ScopeLease MCP/context pack tokens, observed tool payload, command-reported tokens when available | Implemented; named frozen command-reported protocol and 2026-06-08 resource-bounded Codex/Claude C0/C3 command-reported protocols are claim-ready |
| Permission boundary | guard verdicts, approval lease creation, lease hits, deny/ask/allow counts | Implemented and covered by fixtures |
| Enforcement boundary | `PreToolUse` hook or `scopelease guarded-exec` blocks ask/deny before execution | Implemented for connected hosts only |
| Decision burden proxy | number of explicit prompts versus lease reuse or automatic denial | Implemented as proxy; human fatigue still needs study |
| Review frontier | omitted critical files, leakage, merge errors, intent consistency, boundary preservation | Implemented as automated fixture |
| Call reduction | number of broad search/read calls versus graph frontier calls | Implemented as graph-bench diagnostic |
| Agent completion | pass/fail, tests, iteration count, stop reason in fresh snapshots | Implemented in formal runner schema; resource-bounded C0/C3 local-main runs completed for Codex and Claude |
| Generalization | repo family, task taxonomy, agent preset, repeated runs | Protocol implemented for local C0/C3 command-reported claims; broader four-condition or public benchmark claims need additional runs |

## What Counts as Current Evidence

Current averages may be reported only when all of these are true:

- same `workIntent`
- same `pairId`
- same repository snapshot or declared reset state
- one C0 baseline lane and one C3 full ScopeLease lane for headline paired deltas
- Codex C0 command runs must use an isolated command template without ScopeLease MCP or ScopeLease hooks; the C3 lane alone receives project-local ScopeLease MCP/hook config
- Codex and Claude runs are separated by agent preset
- provider billing is excluded unless both lanes provide provider usage with matching metadata
- negative deltas are retained
- quality boundary passes before efficiency is used as a headline

The default claim metric is observed agent-visible or command-reported usage, not provider billing.

## Required Fresh-Run Conditions

Use these conditions for patent and CHI evidence:

| Condition | Agent | ScopeLease Hook | Purpose |
| --- | --- | --- | --- |
| C0 baseline | Codex or Claude app/CLI | off | ordinary agent behavior |
| C1 context only | Codex or Claude app/CLI | off | ScopeLease decision card and read/review frontier only |
| C2 guard only | Codex or Claude app/CLI | on | guard/hook effect without context card or reusable signed lease |
| C3 full ScopeLease | Codex or Claude app/CLI | on | same work intent with ScopeLease context, boundary, signed lease, and stop frontier |

Minimum useful target:

- 10 to 20 repositories
- 100 or more paired task runs
- task families covering bug fix, feature addition, refactor, test repair, documentation/API understanding, permission-sensitive work, and review-frontier tasks
- at least three repeats for unstable command-level measurements

MLE-bench-like or official benchmark tasks may be included when they are adapted into coding-agent work intents with observable completion, tests, and pair metadata. They should not replace ordinary repository maintenance tasks.

## Current Automated Verification Snapshot

The local implementation currently verifies the mechanism, not a universal average:

- unit and integration tests pass under `SCOPELEASE_DISABLE_TIKTOKEN=1 npm test` with 94/94 pass, 0 fail, 0 skipped in the current verification environment
- desktop package check passes under `npm run desktop:check`
- `npm run paper:review-bench` passes with 23/23 tasks. The current fresh run reports 1,850 -> 552 candidate files, 70% file reduction, 62% rough file-read token reduction, 100% critical-file recall, and 93% critical-file recall@10. The frozen paper source-of-truth remains 1,771 -> 552, 69%/61%, because documentation churn can move fresh file-count proxies.
- `npm run paper:report:controlled` regenerates `.scopelease/reports/delegation-control-controlled/` with status `mechanism_ready_live_pairs_needed`
- `npm run paper:report:full` regenerates the fresh sanity-check report at `.scopelease/reports/delegation-control-fresh/`; it intentionally does not overwrite `.scopelease/reports/delegation-control-source-of-truth-20260528/`
- `npm run paper:freeze-evidence` is the explicit command for updating the source-of-truth/frozen evidence packet after a deliberate paper-evidence refresh
- `npm run paper:report` passes and aliases the full report path
- the report scripts are split into concise `:fixtures` and `:delegation` steps so artifact-reviewer runs stay short while preserving the same generated report directories
- `npm run paper:verify:frozen` passes and independently checks the frozen evidence package against the current headline metrics: status `controlled_delegation_evidence_ready_live_completion_and_human_needed`, command-reported token saving `64%`, `3,560,061 -> 1,280,323`, review frontier `1,771 -> 552`, file-read proxy reduction `61%`, tool-call proxy reduction `69%`, critical-file recall `100%`, critical-file recall@10 `93%`, permission fixtures `12/12`, controlled ablation rows `92`, and C3 silent failures `0`
- permission fixtures verify guard, ask, deny, approve, and lease-hit behavior
- connected enforcement is available through project-local Codex `PreToolUse` hooks and `scopelease guarded-exec`; it is not a universal sandbox
- the current hook path has been verified active: ScopeLease internal control/startup paths no longer self-deadlock, `apply_patch` path extraction is corrected, safe local reads are quote-aware and pipeline-aware, and report/check/evidence-sync scripts are allowlisted
- `node src/cli.js source-truth-check . --format json` passes: the source-of-truth report and frozen evidence copy match on generated time, headline token metrics, review-frontier metrics, permission fixtures, controlled ablation count, C3 silent failures, and local-path hygiene
- `npm run paper:source-zip` regenerates the root clean archive at `scopelease_clean_source.zip`; `npm run paper:verify:source-zip` checks the zip size, required evidence entries, and local path or user-name leaks, and keeps the archive under the 512 MB cap
- after source edits, restart or reattach any already-running ScopeLease MCP server before relying on its guard/approve output; stale MCP processes can retain older action-policy command scopes even when CLI/hook enforcement has the current code
- review frontier fixtures verify omission, leakage, merge, and intent boundaries
- formal runner can emit `fresh-run-snapshot.json` with agent preset, repo/task inventory, run status, and pair metadata
- `npm run paper:live-pilot:codex` completed on 2026-06-07 at `.scopelease/experiments/pilot-codex-main-20260607`: 1 repository, 4 same-workIntent pairs, 8/8 lane commands passed, 0 timeouts, command-reported total tokens `370,894 -> 281,438` with a `24%` weighted lower delta, macro command delta `20%` lower, median delta `28%` lower, `3` positive and `1` overhead pair, decision-prompt proxy `456 -> 4` (`99%` lower), and duration proxy `363,047ms -> 339,612ms` (`6%` lower). Task-specific completion rubric is not configured. This is a live runner/measurement pilot only, not a formal average because it is below the `10` repository / `100` pair threshold.
- `npm run paper:live-pilot:claude` completed on 2026-06-07 at `.scopelease/experiments/pilot-claude-main-20260607`: 1 repository, 4 same-workIntent pairs, 8/8 lane commands passed, 0 timeouts, Claude CLI JSON usage-reported total tokens `2,304,719 -> 1,674,373` with a `27%` weighted lower delta, macro command delta `22%` lower, median delta `37.5%` lower, `3` positive and `1` overhead pair, decision-prompt proxy `456 -> 4` (`99%` lower), duration proxy `632,181ms -> 426,178ms` (`33%` lower), and heuristic command-quality `4/4` pairs with score `100%`. Task-specific completion rubric is not configured. This is a live runner/measurement pilot only, not a formal average because it is below the `10` repository / `100` pair threshold.
- the historical Claude pilot remains available at `.scopelease/experiments/claude-pilot5`: 1 repository, 4 same-workIntent pairs, command-reported total tokens `2,065,761 -> 1,456,429`, `29%` weighted lower delta, macro delta `32%` lower, `4` positive and `0` overhead pairs. Treat it as a labeled historical pilot until rerun under the current protocol.
- the previous live Codex MCP pilot exists at `.scopelease/experiments/chi-live-mcp-pilot-final-20260601`: 1 repository, 4 same-workIntent pairs, ScopeLease MCP context imported in 4/4 pairs, command-reported total tokens 274,355 -> 248,858 with a 9% weighted lower delta, but macro mean is -10% and 2/4 pairs have overhead; strict agent-visible input is higher under ScopeLease, so this is connection/measurement evidence only
- `npm run paper:formal:fresh:dry-run` currently reports only 1 configured repository and 8 expected pairs against the formal threshold of 10 repositories and 100 pairs, so the official fresh manifest is not ready until `.scopelease/evaluation/fresh-run-repos.json` and the task/repeat plan are expanded.
- `npm run paper:formal:discover-repos` created a local formal manifest at `.scopelease/evaluation/formal-live-local-repos.json` with 13 candidates and 10 included local repositories. This is a local-machine convenience manifest, not an anonymized official benchmark manifest.
- `npm run paper:formal:local-main:dry-run` passes with 10 included repositories and 160 expected same-workIntent pairs, satisfying the configured runner threshold of 10 repositories and 100 pairs. The formal local main wrapper uses run id prefix `formal-local-main-codex`; use `npm run paper:formal:stop-local-main` only as an operator cleanup tool.
- the superseded unbounded `npm run paper:formal:local-main` attempt on 2026-06-07 did not produce a formal main result: `ai-research-os` failed after about 529s with Node heap OOM (`Reached heap limit Allocation failed - JavaScript heap out of memory`), and the following `ai-survey-os` run was operator-stopped. Treat this only as runner/resource failure history.
- `npm run paper:formal:local-main:resource-bounded` completed on 2026-06-08 at `.scopelease/experiments/formal-local-main-codex-resource-bounded`: 11 repositories, 176 same-workIntent C0/C3 command-reported pairs, status `claim_ready`, command-reported total tokens `11,830,597 -> 3,879,686`, `67%` weighted lower, `59%` macro lower, `71%` median lower, `161` positive and `15` overhead pairs.
- `npm run paper:formal:local-main:claude:resource-bounded` completed on 2026-06-08 at `.scopelease/experiments/formal-local-main-claude-resource-bounded`: 11 repositories, 176 same-workIntent C0/C3 command-reported pairs, status `claim_ready`, Claude CLI JSON usage-reported total tokens `49,656,538 -> 21,824,362`, `56%` weighted lower, `38%` macro lower, `52.5%` median lower, `156` positive and `20` overhead pairs.
- the live runner and paper scripts no longer apply implicit command/repo timeouts. Current dry-run manifests report `repoTimeoutMs: 0` and `commandTimeoutMs: 0`; any timeout must be an explicit operator choice, not a hidden experimental parameter.
- Required remaining non-human experiment only for four-condition trajectory claims: add C1 and C2 live lanes over the same resource-bounded manifest or use a preregistered public benchmark panel that records C0/C1/C2/C3 separately. Preserve task completion, verifier output, command-reported tokens, agent-visible context when available, file/tool calls, guard/lease events, review-frontier size and recall, scope drift, unsafe calls, retries, duration, operator stops, and runner/resource failures. Human supervision remains separate and should not be claimed until collected.
- a named 13-repository, 102-pair command-reported protocol remains available at `examples/evaluation/frozen-evidence/formal-command-100pair-mini-20260521-133429/product-wide-summary.json`: 3,560,061 -> 1,280,323 command-reported total tokens, 64% lower; this is not provider billing
- a same-prompt Terminal-Bench smoke exists at `.scopelease/reports/terminal-bench-same-prompt-observed-20260531/tbench-hello-same-prompt-20260531`: `hello-world` resolved 1/1 with 13,901 command-reported tokens; this is not ScopeLease behavior-improvement evidence
- a same-prompt connected Terminal-Bench selected panel exists at `.scopelease/reports/terminal-bench-scopelease-c0c3-20260531/scopelease-terminal-bench-connected-c0c3-panel.json`: 12 selected public tasks and 48 condition runs; C0/C2/C3 resolve 12/12, C1 resolves 11/12, and C3 uses 880,394 command-reported tokens versus C0's 281,547, so this is connection/completion evidence and an overhead finding, not token-saving evidence
- the 2026-06-03 Terminal-Bench refresh at `.scopelease/reports/terminal-bench-scopelease-c0c3-20260603/scopelease-terminal-bench-connected-c0c3-panel.json` is partial only: 2/12 tasks completed, C0/C1/C2 resolve 2/2, C3 resolves 1/2, and `cpp-compatibility` C0 stalled and was terminated on 2026-06-06. It should not replace the complete 2026-05-31 selected panel.
- the Terminal-Bench runner now has an outer `--runner-timeout-sec` around `tb run` and `npm run paper:tbench:stop-scopelease-panel` for scoped cleanup of only the configured ScopeLease panel output root.
- the selected Terminal-Bench panel includes task-scoped internal API delegation: `simple-sheets-put` requires `http://api:8000`, and C3 now passes it through an explicit `allow_task_scoped_network` lease while external network access remains blocked

The current live interactive thread does not by itself prove average savings unless matching C0 baseline and C3 full ScopeLease lanes exist for the same work intent. If `agent-usage` reports `needs_pair`, the result must be reported as insufficient paired evidence.

For live Codex/Claude average-savings wording, require a completed paired run, positive weighted delta, non-negative macro distribution, and more positive than overhead pairs. The 2026-06-07 Codex and Claude lean pilots meet this only as separate one-repository pilots. The 2026-06-01 live MCP pilot does not meet the threshold.

## Patent Wording

Use:

> ScopeLease generates graph-scoped compact context and validates subsequent coding-agent actions with an HMAC-signed approval lease bound to request, baseline, risk, file scope, command scope, approved changed files, stop conditions, and signature.

For connected hosts:

> When Codex `PreToolUse` hooks or `scopelease guarded-exec` route a tool call through ScopeLease, ask/deny actions are blocked before execution and only `allow_with_log` or a valid signed lease can pass.

Avoid:

- "ScopeLease reduces provider billing"
- "ScopeLease proves universal average token savings"
- "ScopeLease physically blocks every tool call in all host agents, including hosts that are not connected to ScopeLease hooks or wrappers"
- "full repository size is the default Codex baseline"
- "human cognitive fatigue is proven without a participant study"

## CHI Wording

CHI framing should be about delegation and inspectability, not just compression:

> ScopeLease studies how graph-scoped context and signed delegation boundaries change what humans must inspect when supervising coding agents.

The quantitative part can report paired context, call, permission, and frontier metrics. The human study should measure perceived control, decision confidence, time to scopeleaserize, missed-risk detection, over-trust, and interruption burden.

## Canonical Commands

```bash
npm test
npm run desktop:check
npm run paper:review-bench
npm run paper:report:controlled
npm run paper:report:full
npm run paper:report
npm run paper:freeze-evidence
npm run paper:verify:frozen

npm run paper:source-truth-check
npm run paper:source-zip
npm run paper:verify:source-zip
npm run paper:tbench:scopelease-panel:dry-run
npm run paper:formal:discover-repos
npm run paper:formal:local-main:dry-run
npm run paper:formal:local-main
npm run paper:formal:local-main:claude:dry-run
npm run paper:formal:local-main:claude
npm run paper:formal:stop-local-main
npm run paper:formal:fresh:dry-run
npm run paper:human-study

SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js permission-fixtures . --run --format json
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js review-bench . \
  --tasks examples/evaluation/patent-paper-review-frontier-tasks.jsonl \
  --max-frontier-files 24 \
  --format json

SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js condition-matrix . \
  --tasks examples/evaluation/patent-paper-review-frontier-tasks.jsonl \
  --format json

SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js delegation-report . \
  --tasks examples/evaluation/patent-paper-review-frontier-tasks.jsonl \
  --max-frontier-files 24 \
  --product-wide-summary examples/evaluation/frozen-evidence/formal-command-100pair-mini-20260521-133429/product-wide-summary.json \
  --output .scopelease/reports/delegation-control-fresh \
  --format json
```

Use these only when collecting new live or official evidence:

```bash
npm run paper:tbench:scopelease-panel
npm run paper:tbench:stop-scopelease-panel
npm run paper:live-pilot

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

SCOPELEASE_DISABLE_TIKTOKEN=1 node scripts/run-formal-command-eval.mjs \
  --repos-file examples/evaluation/formal-command-repos.example.json \
  --tasks examples/evaluation/official-fresh-run-tasks.example.jsonl \
  --repeat 2 \
  --min-repos 10 \
  --min-pairs 100 \
  --default-agent codex \
  --scopelease-agent codex \
  --live-observed-command-mode lean \
  --run-id-prefix formal-fresh-codex-YYYYMMDD-HHMMSS
```
# Current Research Memory Addendum (2026-06-07)

This addendum is the current status boundary for the non-human evidence package.
Older notes in this file should be read through this boundary.

- Latest local verification pass: `npm test` reports 94/94 pass with 0 skipped
  and 0 failed; `npm run desktop:check`, `npm run paper:verify:frozen`, and
  `npm run paper:source-truth-check` pass.
- Latest source archive: `scopelease_clean_source.zip`, verified under the 512 MB
  cap with 340 entries, 279 text files checked, `ok: true`, leaks `[]`.
- Frozen controlled evidence remains the source of truth for the 13-repository,
  102-pair command-reported protocol: 3,560,061 baseline tokens to 1,280,323
  ScopeLease tokens, or 64% weighted reduction.
- Controlled C0-C3 evidence, permission fixtures, review-frontier evidence, and
  the selected same-prompt Terminal-Bench panel remain claimable with their
  existing caveats.
- Codex CLI and Claude CLI one-repository live pilots are complete and are
  documented as bounded pilot evidence only.
- The original broad Codex formal local main attempt is not claimable: it hit a
  Node heap OOM on `ai-research-os`, and the run was stopped before producing a
  formal result.
- The replacement formal protocol is resource-bounded:
  `.scopelease/evaluation/formal-live-local-repos-resource-bounded.json`.
  It includes 11 repositories, excludes virtualenv and `site-packages` trees,
  excludes `ai-research-os` as `over_resource_bound`, de-duplicates repeated
  repo labels, and yields 176 expected pairs per agent.
- Codex and Claude resource-bounded dry-runs pass with `repoTimeoutMs: 0` and
  `commandTimeoutMs: 0`, and both non-dry-run resource-bounded main studies now
  complete with verified product-wide summaries and claim reports.
- The formal runner now writes incremental `run-log.json` and partial
  `final-status.json` records on failures or interruptions, so future long runs
  do not disappear without audit evidence.

Current remaining work for human-outcome claims is the human supervision study.
Current remaining non-human work is only needed if the paper claims broad
four-condition C0/C1/C2/C3 trajectory effects rather than the completed C0/C3
command-reported resource-bounded protocol.
