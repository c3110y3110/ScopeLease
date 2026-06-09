# ScopeLease Delegation-Control Evaluation Summary

Generated from the current implementation and source-of-truth local evidence on 2026-06-03.

## One-Line Position

ScopeLease is currently claimable as a repo-local delegation-control layer, not as a provider-billing saving system.

The implemented claim is:

> ScopeLease builds graph-scoped read, review, permission, and stop frontiers from repository evidence, binds agent scopeleaserity to an action-specific signed approval lease, and reports trajectory-level evidence for context/call reduction, permission safety, review coverage, and silent failure boundaries.

## Completed Implementation

| Area | Implemented artifact | Status |
| --- | --- | --- |
| C0-C3 controlled ablation | `src/core/ablation-runner.js`, `ablation-run` CLI, `delegation-report` integration | Controlled result ready |
| Trajectory event schema | `src/core/trajectory-schema.js` | Ready |
| Silent failure metrics | `src/core/trajectory-metrics.js` | Ready |
| Delegation-control report | `src/core/delegation-report.js`, `delegation-report` CLI | Ready |
| Permission evidence | permission fixtures and signed lease validation | Ready |
| Review boundary evidence | review-frontier benchmark | Ready |
| Token/call boundary | separated observed, command-reported, and proxy metrics | Ready |
| CHI human outcome evidence | participant study only | Not claim-ready |

## Seven Evaluation Axes

| Axis | Meaning | Current status |
| --- | --- | --- |
| A. Task completion | Whether the task still succeeds under the same agent/model/budget | Same-prompt connected Terminal-Bench selected panel completed: 12 public tasks x 4 conditions; C0/C2/C3 resolve 12/12 and C1 resolves 11/12 |
| B. Context and call reduction | Agent-visible tokens, command-reported tokens, and file/tool-call proxy | Controlled/protocol evidence exists; selected public benchmark panel shows ScopeLease overhead on simple tasks rather than savings |
| C. Permission delegation | Allow, ask, deny, lease hit, false allow/block | Fixture ready |
| D. Review boundary quality | Critical-file recall, precision, leakage, merge, intent checks | Controlled frontier ready under the fixed review-card budget |
| E. Silent failure trajectory | Omission, leakage, scope drift, intent drift, merge drift, unsafe call, unnecessary call, escalation error | Controlled C0-C3 result ready; same-prompt public benchmark completion/token labeling ready for selected panel |
| F. Human supervision | Decision accuracy, workload, trust, perceived control | Planned only |
| G. Ablation | C0 baseline, C1 context only, C2 guard only, C3 full ScopeLease | Controlled result ready |

## Latest Local Evidence

The latest generated delegation report is under:

```text
.scopelease/reports/delegation-control-source-of-truth-20260528/
```

The current source-of-truth manifest is:

```text
.scopelease/reports/delegation-control-source-of-truth-20260528/evidence-manifest.json
```

The current frozen evidence copy is:

```text
examples/evaluation/frozen-evidence/delegation-control-source-of-truth-20260528/evidence-manifest.json
```

The report uses this frozen command-reported token evidence as the source-of-truth for the 102-pair token claim:

```text
examples/evaluation/frozen-evidence/formal-command-100pair-mini-20260521-133429/product-wide-summary.json
```

Fresh verification:

```text
npm test: 94/94 pass, 0 fail, 0 skipped in the current verification environment
npm run desktop:check: pass
npm run paper:review-bench: pass; fresh proxy sanity-check currently reports 1,850 -> 552 files, while the frozen paper source-of-truth remains 1,771 -> 552
npm run paper:report:controlled: pass, status mechanism_ready_live_pairs_needed
npm run paper:report:full: pass; writes fresh sanity-check evidence to .scopelease/reports/delegation-control-fresh/ and does not overwrite the frozen source-of-truth report
npm run paper:report: pass, aliases paper:report:full
npm run paper:freeze-evidence: explicit source-of-truth update command; not part of routine fresh sanity-check regeneration
source-truth-check: pass, source and frozen evidence match on generatedAt and headline metrics
paper:verify:source-zip: pass, zip is under 512 MB and no local path/user-name leaks are detected in text entries
permission fixtures: 12/12 pass
controlled C0-C3 ablation: 92 rows over 23 tasks
active hook regression: internal ScopeLease control/startup no longer self-deadlocks; apply_patch path extraction, safe local reads, and report/check/evidence-sync allowlist verified
```

Latest live Codex MCP same-workIntent pilot:

```text
run: .scopelease/experiments/chi-live-mcp-pilot-final-20260601
repo count: 1
measured pairs: 4
model: Codex CLI command adapter
ScopeLease MCP context imported: 4/4 pairs
strict agent-visible input: 418 -> 2,284, 446% higher
command-reported total tokens: 274,355 -> 248,858
weighted command delta: 9% lower
macro command delta: 10% higher
positive / overhead command pairs: 2 / 2
boundary: latest local MCP pilot, mixed distribution, not report-grade average savings
```

## Public Benchmark Evidence Boundary

The previous Terminal-Bench prompt-integrated C1/C2/C3 runs were removed from source-of-truth evidence. They prepended ScopeLease instructions to the benchmark task prompt, so they could not distinguish ScopeLease's mechanism from prompt engineering side effects.

Current public-benchmark position:

| Item | Status | Claim boundary |
| --- | --- | --- |
| Same-prompt Terminal-Bench observed parser | Implemented | Parses completion and Codex CLI `tokens used` from unchanged task-prompt runs |
| Host-side ScopeLease enforcement in normal Codex projects | Implemented | `PreToolUse`, `scopelease enforce`, and `guarded-exec` can block ask/deny before execution |
| Host-side ScopeLease connection inside Terminal-Bench containers | Implemented for selected panel | C1/C2/C3 attach MCP/hooks/AGENTS metadata without mutating the benchmark prompt |
| Prompt-integrated C1/C2/C3 Terminal-Bench numbers | Removed | Do not cite for CHI/patent result claims |

Same-prompt connected public-task panel:

```text
run root: .scopelease/reports/terminal-bench-scopelease-c0c3-20260531/
tasks: hello-world, jsonl-aggregator, cpp-compatibility, regex-log, log-summary-date-ranges, simple-sheets-put, jq-data-processing, tree-directory-parser, heterogeneous-dates, assign-seats, openssl-selfsigned-cert, cancel-async-tasks
conditions: C0, C1, C2, C3
prompt mutation: none
summary: scopelease-terminal-bench-connected-c0c3-panel.json
```

| Condition | Meaning | Resolved | Command-reported tokens | Delta vs C0 |
| --- | --- | ---: | ---: | ---: |
| C0 | Baseline Codex CLI | 12/12 | 281,547 | baseline |
| C1 | ScopeLease context/MCP/AGENTS sidecar only | 11/12 | 373,207 | 91,660 more tokens, 32.56% higher |
| C2 | ScopeLease init+attach hooks only | 12/12 | 320,186 | 38,639 more tokens, 13.72% higher |
| C3 | Full ScopeLease connected condition | 12/12 | 880,394 | 598,847 more tokens, 212.70% higher |

The panel includes one task-required internal API case (`simple-sheets-put`), a certificate-generation task (`openssl-selfsigned-cert`), a constraint-solving task (`assign-seats`), and a harder async implementation task (`cancel-async-tasks`). C3 originally over-blocked the internal API case as generic network access. The current implementation fixes this by allowing only task-prompt-declared internal origins through an explicit `allow_task_scoped_network` signed lease while continuing to deny external network targets.

Observed failure pattern: context-only C1 fails `cancel-async-tasks`, while C0, C2, and C3 resolve it. This supports the interpretation that context alone is not the full mechanism. It does not prove that C3 improves task success generally.

The correct next public benchmark is either:

1. a same-prompt observed run that reports only completion and command-reported tokens, or
2. a connected-host run where ScopeLease enforcement/context is actually attached without changing the benchmark prompt.

The selected panel above satisfies the second requirement for a selected local public-task panel, but it does **not** show token savings. It shows that ScopeLease can be connected without breaking C0-level completion in the full C3 condition, that task-scoped internal API access can be delegated without opening external network access, and that these Terminal-Bench tasks pay substantial sidecar/hook/context overhead. Full official benchmark claims still require a larger pre-registered task set across more task families and repositories.

Permission fixture summary:

| Metric | Value |
| --- | ---: |
| Total fixtures | 12 |
| Passed | 12 |
| Failed | 0 |
| Human prompts | 4 |
| Denies | 6 |
| Lease hits | 1 |
| Unsafe false allows | 0 |
| False blocks | 0 |
| False denies | 0 |

Permission confusion matrix:

| Expected \\ Actual | allow_with_log | ask_once | deny |
| --- | ---: | ---: | ---: |
| allow_with_log | 2 | 0 | 0 |
| ask_once | 0 | 4 | 0 |
| deny | 0 | 0 | 6 |

Review-frontier summary:

| Metric | Value |
| --- | ---: |
| Tasks | 23 |
| Passed tasks | 23 |
| Failed tasks | 0 |
| Baseline candidate files | 1,771 |
| ScopeLease review-frontier files | 552 |
| Candidate file reduction | 69% |
| Rough file-read token reduction | 61% |
| Critical-file recall | 100% |
| Critical-file precision | 15% |
| Median first critical-file rank | 1 |
| Median critical-file rank | 2 |
| Critical-file recall@10 | 93% |
| Task top-5 hit rate | 100% |
| Leakage failures | 0 |
| Merge failures | 0 |
| Intent failures | 0 |

The source-of-truth report fixes `--max-frontier-files 24` as the review-card budget. Reported values below are valid for that configuration only.

Controlled C0-C3 ablation summary:

This is a controlled manifest-level mechanism evaluation, not live agent task completion.

| Condition | Meaning | Boundary pass | Live completion | Visible files | Proxy tokens | Unsafe calls | Escalation errors | Human prompts | Lease hits | Silent failures |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| C0 | Baseline agent, no ScopeLease context or guard | 18/23 | not measured | 1,771 | about 9.77M | 2 | 2 | 0 | 0 | 7 |
| C1 | ScopeLease context/review frontier only | 19/23 | not measured | 552 | about 3.78M | 2 | 2 | 0 | 0 | 6 |
| C2 | ScopeLease guard only, no signed lease/context frontier | 22/23 | not measured | 1,771 | about 9.77M | 0 | 0 | 4 | 0 | 1 |
| C3 | Full ScopeLease: context, review, guard, signed lease, stop frontier | 23/23 | not measured | 552 | about 3.78M | 0 | 0 | 2 | 2 | 0 |

Controlled C3 vs C0 deltas:

| Metric | Delta |
| --- | ---: |
| Visible file reduction | 69% |
| Proxy token reduction | 61% |
| Unsafe-call reduction | 100% |
| Escalation-error reduction | 100% |
| Silent failure count | 7 -> 0 |

Controlled C3 vs C2 isolates the signed-lease/context effect: human prompts fall from 4 to 2 and visible files fall by 69%, while guard-related unsafe/escalation failures stay at 0 in both C2 and C3.

Boundary: this is `controlled_task_manifest_ablation_not_live_agent_execution`. It supports mechanism decomposition for patent/CHI planning, but it is not a substitute for live Codex/Claude or official benchmark C0-C3 runs.

Note: proxy token totals are file-content-derived and can move slightly when documentation files change. The stable source-of-truth for exact totals is the frozen report path above; paper text should emphasize the fixed configuration and percentage/call deltas.

## Token And Call Reduction

These numbers must not be merged into one headline. They measure different things.

| Source | Baseline | ScopeLease | Delta | Status |
| --- | ---: | ---: | ---: | --- |
| Live observed agent-visible pairs | 0 | 0 | unavailable | Not enough real-use pairs |
| Latest live Codex MCP command-reported pilot | 274,355 tokens | 248,858 tokens | 9% lower weighted, 10% higher macro | 1 repo / 4 pairs; mixed distribution, no average savings claim |
| Latest live Codex MCP agent-visible strict input | 418 tokens | 2,284 tokens | 446% higher | 1 repo / 4 pairs; ScopeLease context overhead, no prompt-token savings claim |
| Formal command-reported protocol | 3,560,061 tokens | 1,280,323 tokens | 64% lower | Claim-ready for command-reported total tokens only |
| Same-prompt connected Terminal-Bench selected panel | 281,547 tokens | 880,394 tokens | 213% higher in C3 | 12 public tasks; C0/C2/C3 completion preserved, no savings claim |
| Review file-read proxy | about 9.77M rough file-read tokens | about 3.78M rough file-read tokens | 61% lower | Controlled proxy evidence |
| Review tool-call proxy | 1,771 calls | 552 calls | 69% lower | Controlled proxy evidence |
| Controlled C3 vs C0 proxy | about 9.77M tokens / 1,771 files | about 3.78M tokens / 552 files | 61% token, 69% file lower | Controlled C0-C3 mechanism evidence |

Strict interpretation:

- The latest live Codex MCP pilot is useful because it verifies real Codex command execution, MCP context import, pair selection, and token parsing. It does not support a live average savings claim: command-reported totals have a small weighted positive delta, but macro mean is negative and half the pairs have overhead; strict agent-visible input is larger under ScopeLease.
- The 64% formal command-reported result comes from `examples/evaluation/frozen-evidence/formal-command-100pair-mini-20260521-133429/product-wide-summary.json`: 13 repositories, 102 same-workIntent command-reported pairs, 96 positive pairs, and 6 overhead pairs. It is claim-ready only for the named command-reported protocol.
- The 61% file-read token reduction is a review-frontier proxy from the latest report, not natural Codex token usage.
- The 69% call reduction means the review candidate surface is smaller in the latest report, not that every agent run will make 69% fewer calls.
- Same-prompt Terminal-Bench connected runs may report completion and command-reported tokens under C0-C3. The current selected panel preserves C0-level completion in C3 across 12 tasks but shows overhead; it must not be used as token-saving evidence.
- Product-wide average live-observed agent-visible token saving is not claim-ready until enough same-workIntent C0/C3 live-observed pairs are collected.
- Provider/API billing saving is not measured here and must not be inferred from command-reported tokens.

Distribution for the 102-pair formal command protocol:

| Metric | Value |
| --- | ---: |
| Repositories | 13 |
| Measured pairs | 102 |
| Weighted saved tokens | 2,279,738 |
| Weighted saved percent | 64% |
| Macro mean saved percent | 53% |
| Median saved percent | 62% |
| Q1 / Q3 | 36.75% / 73% |
| Min / Max | -89% / 93% |
| Positive / overhead pairs | 96 / 6 |

By task type:

| Task type | Pairs | Weighted saved percent | Median | Overhead pairs |
| --- | ---: | ---: | ---: | ---: |
| devops_config | 26 | 50% | 41% | 3 |
| test_validation | 26 | 57% | 59.5% | 0 |
| architecture_review | 25 | 67% | 64% | 0 |
| permission_workflow | 25 | 71% | 74% | 3 |

## Claimable Now

The current implementation supports these claims:

- ScopeLease constructs graph-scoped delegation frontiers from repository state, baseline diff, policies, and task intent.
- ScopeLease issues and validates action-specific HMAC-signed approval leases.
- ScopeLease distinguishes read, review, permission, and stop boundaries.
- ScopeLease can reduce controlled review candidate surface while preserving critical-file recall in the current fixture set under the fixed review-card budget.
- ScopeLease can report the latest live Codex MCP pilot as a measurement/connection result: 4 same-workIntent pairs, MCP context imported in all ScopeLease lanes, command-reported total tokens `274,355 -> 248,858` weighted lower, but macro mean negative and `2/4` pairs overhead. This is not a formal average savings result.
- ScopeLease can report a claim-ready command-reported token reduction for the named 13-repository, 102-pair formal command protocol, while preserving negative and overhead pairs in the distribution.
- ScopeLease can report a same-prompt connected Terminal-Bench selected panel over 12 public tasks and four conditions: C0/C2/C3 resolve 12/12, C1 resolves 11/12, and C3 uses more command-reported tokens than C0. This is connection/completion evidence and an overhead finding, not token-saving evidence.
- ScopeLease cannot currently claim a general live benchmark token reduction: the invalid prompt-integrated Terminal-Bench numbers have been removed, and the valid same-prompt connected panel shows overhead on selected public tasks.
- ScopeLease can report token and call deltas without mixing provider billing, agent-visible input, command-reported totals, and proxy file-read estimates.
- ScopeLease can expose silent failure axes for omission, leakage, scope drift, intent drift, merge drift, unsafe calls, unnecessary calls, and escalation errors.
- ScopeLease can report controlled C0-C3 mechanism decomposition showing that C1 accounts for context/review-surface reduction, C2 accounts for unsafe/escalation blocking, and C3 combines both while using signed leases to reduce repeated prompts relative to C2.

## Not Claimable Yet

Do not claim the following from the current evidence:

- Provider/API billing reduction.
- Product-wide average provider-billing or hidden-token reduction.
- General live Codex/Terminal-Bench token reduction.
- Live agent-visible prompt/context token reduction.
- Report-grade live Codex average from the 1-repository/4-pair pilot.
- ScopeLease-caused Terminal-Bench behavior improvement from the same-prompt smoke alone.
- Human fatigue, workload, trust, perceived control, or decision accuracy improvement.
- Universal sandboxing independent of host routing.
- Natural Codex default behavior as full-repository reading.

## Completion Criteria For Stronger Paper Evidence

For CHI or a strong empirical paper, collect:

1. For command-reported token claims, the current formal protocol already has 13 repositories and 102 same-workIntent pairs; for live agent-visible claims, collect enough fresh C0/C3 observed pairs under the same threshold.
2. Fixed model, agent, scaffold, budget, timeout, and retry policy.
3. Larger live or official C0/C1/C2/C3 ablations under fixed model, scaffold, budget, verifier, timeout, and retry policy. Terminal-Bench has a selected same-prompt connected 12-task panel; it still needs a larger pre-registered task set. SWE-bench/SWE-Atlas/MLE-bench are still preflight/blocker status.
4. Official or public-task adapters where feasible, such as SWE Atlas, HiL-Bench-style tasks, SWE-bench-family issue tasks, and MLE-bench-style workflow tasks.
5. Fresh-run manifests must use the canonical seven axes: `A_task_completion`, `B_context_call`, `C_permission_delegation`, `D_review_boundary`, `E_silent_failure`, `F_human_supervision`, and `G_ablation`.
6. Fresh-run snapshot conditions must be recorded as `C0`, `C1`, `C2`, and `C3`; legacy names such as `no_scopelease`, `graph_only`, or `scopelease_full` are only explanatory labels.
7. Participant data before making human fatigue, control, trust, or decision-quality claims.

## Patent Use

For patent drafting, the strongest implemented mechanism is:

> A computer-implemented method that builds repo-local graph frontiers from baseline-bound repository evidence, creates an action-specific decision bundle, issues an HMAC-signed approval lease bound to request, baseline, risk, file scope, command scope, graph scope, and stop conditions, and revalidates subsequent coding-agent actions against that lease.

The evaluation evidence should be used as support for the technical effect, not as an overbroad cost-saving claim.
