# ScopeLease CHI Paper Readiness

Generated from the current source-of-truth evidence on 2026-06-06.
Last verification update: 2026-06-08.

## Current Thesis

ScopeLease should be written as a human-agent delegation system, not as a token-saving system.

The CHI-facing thesis is:

> ScopeLease turns local coding-agent approval prompts into graph-scoped delegation contracts that define what an agent may read, review, change, execute, and stop on.

The system contribution is the combination of repo-local graph evidence, baseline diff, read/review/permission/stop frontiers, and action-specific signed approval leases.

## Current Readiness

| Area | Status | Paper interpretation |
| --- | --- | --- |
| System mechanism | Ready | Repo-local graph, C0-C3 modes, frontiers, guard, signed lease, and selected host enforcement paths are implemented. |
| Controlled review/permission evidence | Ready | Supports mechanism validity and claim boundaries. |
| Selected public Terminal-Bench panel | Ready as selected actual benchmark evidence | Shows same-prompt connection/completion across 12 public tasks and 48 condition runs; it does not show token savings. |
| Formal command-reported token protocols | Ready for bounded claims | Supports the frozen 13-repository, 102-pair protocol and the 2026-06-08 resource-bounded Codex/Claude local-main protocols. These are command-reported results, not provider billing. |
| Larger official/public C0-C3 benchmark | Partial | Terminal-Bench selected panel is actual and connected; the 2026-06-03 refresh is only a 2-task partial rerun, and broader SWE Atlas/SWE-bench/MLE-bench official C0-C3 runs are still needed before broad benchmark-level claims. |
| Live Codex same-workIntent pilot | Pilot only | The 2026-06-07 lean pilot completed 4 pairs, 8/8 lane commands passed, and validates the live runner/measurement path without timeouts, but it is one repository and below the formal 10-repository/100-pair threshold. |
| Live Claude same-workIntent pilot | Pilot only | The 2026-06-07 lean pilot completed 4 pairs, 8/8 lane commands passed, and validates the Claude runner/measurement path without timeouts, but it is one repository and below the formal 10-repository/100-pair threshold. |
| Resource-bounded formal local Codex/Claude main | Complete for C0/C3 command-reported local-main claims | Both non-dry-run local-main studies completed on 2026-06-08 over the same 11-repository resource-bounded manifest and 176 same-workIntent pairs per agent. Codex reports `11,830,597 -> 3,879,686` command-reported tokens (`67%` weighted lower); Claude reports `49,656,538 -> 21,824,362` (`56%` weighted lower). |
| Human study | Not complete | Required before claiming reduced fatigue, workload, trust calibration, perceived control, or decision accuracy. |

Current paper state:

```text
mechanism-ready
non-human-controlled-evaluation-ready
selected-live-agent-panel-ready
current-claude-pilot-ready
paper-framing-ready
human-outcome-study-pending
resource-bounded-codex-claude-main-complete
broader-four-condition-c0c3-study-pending-for-general-benchmark-claims
not a provider-billing or general-token-savings paper
```

As of the latest regeneration, the non-human evidence package is internally
consistent: `source-truth-check` passes against the frozen evidence copy with
matching generated time and headline metrics. `npm run paper:verify:frozen`
also passes against the frozen evidence package, checking the CHI headline
numbers and local-path hygiene directly. The clean source archive has a
separate zip-level verifier for size and local path/user-name sanitation. Human
supervision remains a planned study and should be excluded from current human
outcome claims. The resource-bounded Codex/Claude local main now supplies a
completed C0/C3 command-reported same-workIntent protocol. Broader four-condition
C0-C3 evidence still needs C1/C2 live lanes or a public panel that records all
four conditions before making general four-condition benchmark claims.

## Source Of Truth

Use these documents and artifacts for current CHI writing:

| Purpose | Source |
| --- | --- |
| Current claim boundary and headline numbers | `docs/delegation-control-evaluation-summary.md` |
| C0-C3 environment and commands | `docs/experimental-environment.md` |
| Trajectory metric design | `docs/trajectory-evaluation-design.md` |
| Product and measurement boundary | `docs/current-product.md` |
| Current memory / canonical commands | `docs/current-research-memory.md` |
| Controlled delegation report | `.scopelease/reports/delegation-control-source-of-truth-20260528/delegation-control-report.json` |
| Frozen evidence manifest | `examples/evaluation/frozen-evidence/delegation-control-source-of-truth-20260528/evidence-manifest.json` |
| Frozen evidence verifier | `npm run paper:verify:frozen` |
| Clean source archive | `scopelease_clean_source.zip` |
| Clean source archive verifier | `npm run paper:verify:source-zip` |
| Terminal-Bench selected panel | `.scopelease/reports/terminal-bench-scopelease-c0c3-20260531/scopelease-terminal-bench-connected-c0c3-panel.json` |
| Terminal-Bench 2026-06-03 partial refresh | `.scopelease/reports/terminal-bench-scopelease-c0c3-20260603/scopelease-terminal-bench-connected-c0c3-panel.json` |
| Formal command token protocol | `examples/evaluation/frozen-evidence/formal-command-100pair-mini-20260521-133429/product-wide-summary.json` |
| Latest live Codex lean pilot | `.scopelease/experiments/pilot-codex-main-20260607/product-wide-summary.json` |
| Latest live Claude lean pilot | `.scopelease/experiments/pilot-claude-main-20260607/product-wide-summary.json` |
| Resource-bounded Codex formal local main | `.scopelease/experiments/formal-local-main-codex-resource-bounded/product-wide-summary.json` and `.scopelease/reports/formal-local-main-codex-resource-bounded/claim-ready-report.md` |
| Resource-bounded Claude formal local main | `.scopelease/experiments/formal-local-main-claude-resource-bounded/product-wide-summary.json` and `.scopelease/reports/formal-local-main-claude-resource-bounded/claim-ready-report.md` |
| Superseded failed Codex formal local-main attempt log | `.scopelease/experiments/formal-local-main-codex/logs/formal-local-main-codex-ai-research-os.stderr.log` |
| Historical Claude pilot | `.scopelease/experiments/claude-pilot5/product-wide-summary.json` |
| Previous live Codex MCP connection pilot | `.scopelease/experiments/chi-live-mcp-pilot-final-20260601/summary.json` |

The `docs/*20260527.md` files are supporting analysis. They are not current source-of-truth result documents.

## Claimable Now

These claims are aligned with the current implementation and evidence:

- ScopeLease implements graph-scoped read, review, permission, and stop frontiers for coding-agent delegation.
- ScopeLease binds approval to action-specific HMAC-signed leases over request, baseline, risk, file scope, command scope, graph scope, and stop conditions.
- ScopeLease can distinguish provider billing, command-reported token totals, agent-visible context, and file-read proxy tokens.
- ScopeLease now exports a bounded clean source archive under the 512 MB cap, sanitizes local absolute paths and user-name path variants before packaging, and verifies the resulting zip contents directly.
- In the controlled review-frontier fixture, ScopeLease reduces candidate review files from `1,771` to `552` under the fixed review-card budget while preserving `100%` critical-file recall.
- The reduced frontier is recall-first but now rank-audited: median first critical-file rank is `1`, median critical-file rank is `2`, task top-5 hit rate is `100%`, and critical-file recall@10 is `93%`.
- In permission fixtures, expected-vs-actual verdict confusion is clean for the current suite: unsafe false allows `0`, false blocks `0`, false denies `0`, and mismatches `0`.
- In controlled C0-C3 mechanism evaluation, C3 combines context reduction and guard behavior: visible files drop from `1,771` to `552`, proxy file-read tokens drop by `61%`, unsafe calls drop from `2` to `0`, escalation errors drop from `2` to `0`, and silent failure count drops from `7` to `0`.
- The active Codex hook path has a current regression check: internal ScopeLease control/startup paths avoid self-approval deadlock, `apply_patch` path extraction is corrected, safe local reads are quote-aware and pipeline-aware, and report/check/evidence-sync scripts are allowlisted.
- In the selected same-prompt Terminal-Bench panel, `47/48` condition runs resolve over `12` public tasks. C0, C2, and C3 each resolve `12/12`; C1 resolves `11/12`. This includes task-scoped internal API access, certificate generation, constraint solving, and a harder async implementation task.
- In that Terminal-Bench panel, C3 preserves C0 completion (`12/12` vs `12/12`) but uses more command-reported tokens (`880,394` vs `281,547`). This is actual connected benchmark evidence for feasibility and overhead, not token savings.
- In the named formal command-reported protocol, `102` same-workIntent pairs over `13` repositories show `3,560,061 -> 1,280,323` command-reported total tokens, a `64%` weighted reduction. This is a protocol-specific command-reported result, not provider billing.
- In the latest live Codex lean pilot generated on 2026-06-07, `4/4` same-workIntent pairs completed on one repository and `8/8` lane commands exited 0 with `0` timeouts. Command-reported total tokens were `370,894 -> 281,438`, a `24%` weighted reduction, with macro reduction `20%`, median reduction `28%`, `3` positive pairs, and `1` overhead pair. Decision-prompt proxy suppression was `456 -> 4` (`99%` lower). Command wall-time proxy was `363,047ms -> 339,612ms`, `6%` lower. Heuristic command-quality pass lanes were `5/8` with score `90.63%`; task-specific completion rubric was not configured. This is live-runner/measurement evidence only, not a formal product-wide or CHI generalization result.
- In the latest live Claude lean pilot generated on 2026-06-07, `4/4` same-workIntent pairs completed on one repository and `8/8` lane commands exited 0 with `0` timeouts. Claude CLI JSON usage-reported total tokens were `2,304,719 -> 1,674,373`, a `27%` weighted reduction, with macro reduction `22%`, median reduction `37.5%`, `3` positive pairs, and `1` overhead pair. Decision-prompt proxy suppression was `456 -> 4` (`99%` lower). Command wall-time proxy was `632,181ms -> 426,178ms`, `33%` lower. Heuristic command-quality passed `4/4` pairs with score `100%`; task-specific completion rubric was not configured. This is live-runner/measurement evidence only, not a formal product-wide or CHI generalization result.
- In the resource-bounded Codex formal local main generated on 2026-06-08, `176` same-workIntent C0/C3 command-reported pairs completed across `11` local repositories. Command-reported total tokens were `11,830,597 -> 3,879,686`, a `67%` weighted lower delta, with macro reduction `59%`, median reduction `71%`, `161` positive pairs, and `15` overhead pairs. The protocol has `status: claim_ready`, `minRepos: 10`, and `minPairs: 100`.
- In the resource-bounded Claude formal local main generated on 2026-06-08, `176` same-workIntent C0/C3 command-reported pairs completed across the same `11` local repositories. Claude CLI JSON usage-reported total tokens were `49,656,538 -> 21,824,362`, a `56%` weighted lower delta, with macro reduction `38%`, median reduction `52.5%`, `156` positive pairs, and `20` overhead pairs. The protocol has `status: claim_ready`, `minRepos: 10`, and `minPairs: 100`.
- The historical Claude pilot at `.scopelease/experiments/claude-pilot5/` remains a labeled pilot artifact: `4` pairs, command-reported tokens `2,065,761 -> 1,456,429`, `29%` weighted reduction, macro reduction `32%`, `4` positive pairs, `0` overhead pairs. It is historical and still below the formal floor.
- The previous live Codex MCP pilot remains useful for connection evidence: all `4/4` ScopeLease lanes imported MCP context, but strict agent-visible input was higher under ScopeLease and the command-token distribution was mixed (`2` positive, `2` overhead).
- The 2026-06-03 Terminal-Bench refresh was stopped after a partial rerun on 2026-06-06. It currently contains only `2/12` tasks: C0/C1/C2 resolve `2/2`, C3 resolves `1/2`, and `jsonl-aggregator` C3 is unresolved. `cpp-compatibility` C0 stalled and was terminated. This partial refresh does not replace the complete 2026-05-31 selected panel.

## Not Claimable Yet

Do not make these claims in the CHI paper before new evidence:

- ScopeLease reduces provider/API billing.
- ScopeLease generally reduces live Terminal-Bench, SWE-bench, SWE Atlas, MLE-bench, or provider/API token usage.
- ScopeLease reduces live agent-visible prompt/context tokens. The latest strict live pilot shows agent-visible overhead, not savings.
- The 2026-06-07 Claude lean pilot is a formal CHI main result. It is a one-repository, four-pair pilot below the `10` repository / `100` pair threshold.
- The superseded 2026-06-07 attempted Codex formal local main is a CHI main result. It failed with Node heap OOM on the first repository and was operator-stopped during the following repository, with no formal wrapper run-log or final-status artifact.
- ScopeLease reduces human fatigue, workload, or decision time.
- ScopeLease improves trust calibration, perceived control, or delegation decision accuracy.
- ScopeLease improves official benchmark success rate.
- The 2026-06-07 live Codex pilot is a formal CHI main result. It is a one-repository, four-pair pilot below the `10` repository / `100` pair threshold.
- A broad live four-condition C0-C3 main has been completed. The current resource-bounded local main completes C0/C3 command-reported pairs only; C1/C2 live lanes remain separate work if the paper claims four-condition trajectory effects.
- ScopeLease universally sandboxes an agent without host-side routing through guard/enforcer hooks.
- Natural Codex or Claude default behavior reads the full repository.

## CHI Evaluation Plan

### Study 1: Agent Trajectory Evaluation

The resource-bounded local main now satisfies the non-human C0/C3 command-
reported floor: 11 repositories and 176 same-workIntent pairs per agent for
both Codex and Claude. Treat Codex and Claude as separate result strata.

A CHI paper that claims broad live four-condition C0-C3 trajectory evidence
must still add C1/C2 live lanes or use a preregistered public panel that records
all four conditions. Controlled C0-C3 mechanism evidence already exists, but it
is not the same as a broad live four-condition agent-trajectory main.

Use four conditions:

| Condition | Meaning |
| --- | --- |
| C0 | Baseline agent with no ScopeLease context or guard. |
| C1 | ScopeLease context/review frontier only. |
| C2 | ScopeLease guard only, without signed reusable leases. |
| C3 | Full ScopeLease: context, review frontier, guard, signed lease, and stop frontier. |

Report at least these axes:

| Axis | Metrics |
| --- | --- |
| Task completion | pass/fail, verifier output, timeout, invalid run |
| Context/call | command-reported tokens, agent-visible context when available, file/tool calls, file-read proxy |
| Permission | ask, deny, allow, lease hit, false allow, false block |
| Review | critical-file recall, precision, candidate surface, rank of critical files |
| Silent failure | omission, leakage, scope drift, intent drift, merge drift, unsafe call, unnecessary call, escalation error |
| Overhead | duration, failed commands, retries, blocked useful actions |

### Study 2: Human Supervision

This is required for CHI human-outcome claims. Minimum conditions:

| Condition | Meaning |
| --- | --- |
| H0 | Native agent approval prompt |
| H1 | Graph/context-only decision card |
| H2 | Guard-only decision without reusable lease |
| H3 | ScopeLease full decision card and signed lease |

Primary measures are delegation decision accuracy, unsafe allow rate, out-of-scope detection, remembered scope accuracy, decision time, and workload. Prompt count and unnecessary interrupt rate are secondary decision-burden proxies.

Participant plan: pilot with 6 to 8 participants for task and instrument validation only; minimum analyzable main study with 24 participants; target main study with 36 participants. Do not claim reduced fatigue, workload, trust calibration, perceived control, or decision accuracy before the main study is collected.

## Paper Framing

Use this framing:

```text
Coding-agent failures are often not visible as benchmark failures.
They appear as silent delegation failures: overbroad calls, missed dependencies,
scope drift, leakage, unsafe autonomy, and misaligned completion.
ScopeLease addresses these failures by replacing local approval prompts with
graph-scoped delegation contracts.
```

Avoid this framing:

```text
ScopeLease is a repository knowledge-graph token optimizer.
```

Token and call reductions can be reported as secondary outcomes only when the measurement boundary is explicit.
# CHI Readiness Addendum (2026-06-07)

Current claim boundary for the CHI package:

- ScopeLease is ready to be framed as a graph-scoped delegation-control system with
  controlled mechanism evidence, verified frozen evidence, and bounded live
  pilot evidence on both Codex CLI and Claude CLI.
- The package can claim controlled reductions in visible review frontier and
  command-reported context load where those numbers come from the frozen
  source-of-truth evidence.
- The selected Terminal-Bench panel can be used as same-prompt public task
  connection evidence: C3 preserved C0-level completion in the selected panel
  while incurring substantial command-reported overhead. It should not be used
  as a token-saving claim.
- Codex and Claude one-repository live pilots can be reported as feasibility
  pilots and are superseded for formal C0/C3 command-reported claims by the
  resource-bounded local main.
- The broad resource-bounded Codex/Claude C0/C3 local main is now a result: 11
  repositories and 176 completed same-workIntent pairs per agent, with no
  implicit command or repository timeout in the protocol.
- Human evaluation remains required for human supervision outcomes.

Therefore, for the measured C0/C3 command-reported axes, the non-human main is
complete and the remaining human-outcome evidence is the human supervision
study. For a broader four-condition C0-C3 trajectory claim, C1/C2 live lanes or
a public panel with all four conditions remain additional non-human work.
