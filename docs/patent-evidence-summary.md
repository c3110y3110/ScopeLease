# Patent Evidence Summary

This file now describes the current evidence packet shape. It does not preserve older numeric averages as current evidence.

## Patent-Centered Invention

ScopeLease's strongest patent direction is:

> A computer-implemented method that generates graph-derived compact context and review/permission frontiers for a coding agent, then issues and validates an action-specific HMAC-signed approval lease bound to request, baseline, risk, file scope, command scope, graph scope, and stop conditions.

## Current Implementation Evidence

| Component | Implementation evidence |
| --- | --- |
| repo-local graph | `src/core/indexer.js`, `src/core/impact.js`, `src/core/frontier.js` |
| baseline diff | `src/core/change-set.js`, `src/core/repository.js` |
| compact context | `src/core/adaptive-context.js`, `src/core/artifacts.js` |
| action normalization | `src/core/action-policy.js` |
| guard decision | `src/core/guard.js`, `src/core/fatigue-controller.js` |
| signed approval lease | `src/core/approval-lease.js` |
| pre-execution enforcement | `src/core/enforcer.js`, Codex `PreToolUse` hook path, `scopelease guarded-exec` |
| pair metering | `src/core/pair-harness.js`, `src/core/evidence-export.js` |
| provider usage separation | `src/runtime/usage-proxy.js`, `src/core/evidence-export.js` |
| human study protocol generation | `src/core/study-report.js` |

## Evidence Required Before Filing Or Review

Minimum packet:

1. `SCOPELEASE_DISABLE_TIKTOKEN=1 npm test`
2. `npm run desktop:check`
3. permission fixture run with zero hard-deny false allow
4. review-frontier bench with omission/leakage/merge/intent pass
5. guard -> approve -> signed lease -> guard lease-hit reproduction
6. one current fresh pair-run pilot showing raw rows, even if token delta is mixed

Current local packet status:

| Evidence | Current status |
| --- | --- |
| Tests | `94/94 pass, 0 fail, 0 skipped` under `npm test` |
| Desktop check | `npm run desktop:check` passes |
| Permission fixtures | 12/12 pass, 4 asks, 6 denies, 1 lease hit |
| Hook/enforcement regression | active Codex hook path verified; internal ScopeLease control/startup paths avoid self-approval deadlock; `apply_patch` path extraction, safe read-only commands, and report/check allowlist are covered |
| Review frontier | 23/23 controlled tasks, 1,771 -> 552 candidate files, 69% file reduction, 61% rough file-read token reduction, 100% critical recall, 15% precision, median first critical-file rank 1, 93% critical-file recall@10 |
| Controlled C0-C3 | C3 combines review/context reduction with guard and signed-lease behavior; silent failures 7 -> 0 in controlled manifest |
| Latest live Codex lean pilot | 4 same-workIntent pairs on one repository, 8/8 lane commands passed, 0 timeouts, command-reported total tokens 370,894 -> 281,438 with 24% weighted lower delta, 20% macro lower delta, 28% median lower delta, 3 positive and 1 overhead pair, 99% decision-prompt proxy reduction; live runner/measurement pilot only |
| Latest live Claude lean pilot | 4 same-workIntent pairs on one repository, 8/8 lane commands passed, 0 timeouts, Claude CLI JSON usage-reported total tokens 2,304,719 -> 1,674,373 with 27% weighted lower delta, 22% macro lower delta, 37.5% median lower delta, 3 positive and 1 overhead pair, 99% decision-prompt proxy reduction, 33% duration-proxy reduction; live runner/measurement pilot only |
| Resource-bounded Codex formal local main | 11 repositories, 176 same-workIntent C0/C3 command-reported pairs, total tokens 11,830,597 -> 3,879,686, 67% weighted lower, 59% macro lower, 71% median lower, 161 positive and 15 overhead pairs; not provider billing |
| Resource-bounded Claude formal local main | 11 repositories, 176 same-workIntent C0/C3 command-reported pairs, Claude CLI JSON usage-reported total tokens 49,656,538 -> 21,824,362, 56% weighted lower, 38% macro lower, 52.5% median lower, 156 positive and 20 overhead pairs; not provider billing |
| Superseded unbounded Codex formal main attempt | Attempted on 2026-06-07 without implicit command/repo timeouts; `ai-research-os` failed after about 529s with Node heap OOM, `ai-survey-os` was operator-stopped, and no wrapper `run-log.json` or `final-status.json` was written; retained only as runner/resource failure history |
| Historical Claude pilot | 4 same-workIntent pairs on one repository, command-reported total tokens 2,065,761 -> 1,456,429 with 29% weighted lower delta, 32% macro lower delta, 4 positive and 0 overhead pairs; historical pilot only |
| Previous live Codex MCP pilot | 4 same-workIntent pairs, ScopeLease MCP context imported in 4/4 pairs, command-reported total tokens 274,355 -> 248,858 with 9% weighted lower delta but negative macro mean and 2/4 overhead pairs; connection/measurement pilot only |
| Named formal command protocol | 13 repositories, 102 pairs, 3,560,061 -> 1,280,323 command-reported total tokens, 64% lower; not provider billing |
| Terminal-Bench connected panel | 12 selected public tasks x 4 C0-C3 conditions; C0/C2/C3 resolve 12/12, C1 resolves 11/12; C3 uses more command-reported tokens than C0, so this is completion/connection evidence rather than token-saving evidence |
| Terminal-Bench 2026-06-03 refresh | Partial only: 2/12 tasks completed, C0/C1/C2 resolve 2/2, C3 resolves 1/2, and `cpp-compatibility` C0 stalled and was terminated on 2026-06-06; not a replacement for the complete selected panel |
| Task-scoped internal network lease | `simple-sheets-put` C3 resolves by approving only the prompt-declared `http://api:8000` origin through `allow_task_scoped_network`; external network remains denied |
| Frozen evidence manifest | `.scopelease/reports/delegation-control-source-of-truth-20260528/evidence-manifest.json` hashes report inputs and generated outputs |
| Clean source archive | `scopelease_clean_source.zip` regenerated under the 512 MB cap; verifier checks required evidence entries and local path/user-name hygiene |

Current permission fixture confusion summary:

| Expected \\ Actual | allow_with_log | ask_once | deny |
| --- | ---: | ---: | ---: |
| allow_with_log | 2 | 0 | 0 |
| ask_once | 0 | 4 | 0 |
| deny | 0 | 0 | 6 |

Current false-decision counts: unsafe false allow `0`, false block `0`, false deny `0`, mismatches `0`.

Stronger packet:

1. live/official four-condition C0-C3 runs over 10-20 repositories or a pre-registered public benchmark task set if the patent/paper asserts C1/C2 trajectory effects
2. enough same-workIntent C0/C3 live-observed agent-visible pairs before making agent-visible token claims
3. human study before making fatigue, trust, perceived-control, or decision-accuracy claims
4. Codex and Claude reported separately
5. official/fresh task families separated
6. completion preserved
7. token/call/duration deltas reported with overhead rows
8. human study added for CHI claims

## Patent Claim Boundaries

Safe:

- graph-derived context frontier
- graph-derived review frontier
- graph-derived permission and stop frontier
- HMAC-signed approval lease
- lease validation against request/baseline/risk/file/command/stop/signature
- connected pre-execution enforcement through hooks/wrappers
- pair-based metering that refuses unpaired savings claims

Unsafe without more evidence:

- provider billing reduction
- universal sandbox security
- universal token reduction
- human fatigue reduction without a study
- "Codex default reads the entire repository"
- treating the resource-bounded C0/C3 local-main result as provider billing or as a four-condition C0-C3 result
- treating the superseded failed 2026-06-07 unbounded Codex formal local-main attempt as broad live evidence

## Report Wording

Use for the current source-of-truth evidence packet:

> ScopeLease is currently supported as a graph-scoped delegation-control layer. The local evidence shows boundary-preserving review-frontier reduction, fixture-level permission correctness, active connected enforcement, and a named frozen 13-repository, 102-pair command-reported token result. It does not establish provider billing savings or human fatigue reduction.

Use for the current live Codex MCP pilot:

> In a local same-workIntent Codex MCP pilot over one repository and four task pairs, ScopeLease imported MCP context in all ScopeLease lanes. Codex CLI command-reported total tokens were 274,355 for baseline lanes and 248,858 for ScopeLease lanes, but the distribution was mixed: macro mean was negative and two of four pairs had overhead. This is connection and measurement evidence, not report-grade average savings evidence.

Use for the current live Codex lean pilot:

> In a local same-workIntent Codex lean pilot over one repository and four task pairs, Codex CLI command-reported total tokens were 370,894 for baseline lanes and 281,438 for ScopeLease lanes. The weighted command delta was 24% lower with three positive pairs and one overhead pair; all eight lane commands exited successfully and no lane timed out. This is live runner and measurement evidence, not report-grade average evidence, because it is below the 10-repository/100-pair formal threshold and task-specific completion rubrics were not configured.

Use for the current live Claude lean pilot:

> In a local same-workIntent Claude lean pilot over one repository and four task pairs, Claude CLI JSON usage-reported total tokens were 2,304,719 for baseline lanes and 1,674,373 for ScopeLease lanes. The weighted command delta was 27% lower with three positive pairs and one overhead pair; all eight lane commands exited successfully and no lane timed out. This is live runner and measurement evidence, not report-grade average evidence, because it is below the 10-repository/100-pair formal threshold and task-specific completion rubrics were not configured.

Use for the resource-bounded formal local main:

> In the 2026-06-08 resource-bounded formal local main, Codex and Claude were run as separate C0/C3 same-workIntent protocols over the same 11 local repositories and 176 paired tasks per agent. Codex command-reported total tokens were 11,830,597 for baseline lanes and 3,879,686 for ScopeLease lanes, a 67% weighted lower delta with 161 positive and 15 overhead pairs. Claude CLI JSON usage-reported total tokens were 49,656,538 for baseline lanes and 21,824,362 for ScopeLease lanes, a 56% weighted lower delta with 156 positive and 20 overhead pairs. These are command-reported protocol results, not provider billing and not four-condition C0-C3 trajectory evidence.

Use for the historical Claude pilot:

> In the historical `claude-pilot5` artifact, Claude Code command-reported total tokens were 2,065,761 for baseline lanes and 1,456,429 for ScopeLease lanes across four one-repository task pairs, a 29% weighted lower delta with four positive pairs and no overhead pairs. This remains a historical pilot, not a formal main result.

Use for remaining non-human work:

> The remaining non-human trajectory work is only needed for broader four-condition claims: C1 and C2 live lanes, or a public panel that records all C0/C1/C2/C3 conditions on the same task snapshots. Report completion, command-reported tokens, agent-visible context when available, permission and lease events, review frontier size and recall, scope drift, unsafe calls, retries, duration, operator stops, and runner/resource failures. The 2026-06-07 unbounded Codex formal local-main attempt is retained only as resource-failure history.

Use when token/call deltas are mixed:

> The implementation supports signed scoped delegation and boundary-preserving review-frontier generation, but the current fresh run does not support an average savings claim.

Use for the current Terminal-Bench connected panel:

> In a selected same-prompt Terminal-Bench panel, ScopeLease was attached through MCP/context sidecar and Codex hooks without mutating the benchmark task prompt. Across 12 public tasks and 48 condition runs, C0/C2/C3 each resolved 12/12 tasks and C1 resolved 11/12. The panel includes a task-required internal API case handled by a task-scoped network lease, plus certificate-generation, constraint-solving, and async-implementation tasks. The full ScopeLease condition increased Codex CLI command-reported tokens on these selected tasks; therefore this panel supports connection, completion, and scoped delegation feasibility, not token-saving generalization.
# Evidence Boundary Addendum (2026-06-08)

This summary separates claimable evidence from prepared protocol evidence.

Claimable now:

- Verified frozen command-reported evidence over 13 repositories and 102 pairs.
- Controlled C0-C3 mechanism evidence.
- Permission fixture, review-frontier, and source-zip verification evidence.
- Codex CLI and Claude CLI one-repository live pilot evidence as bounded
  feasibility evidence.
- Resource-bounded formal local main for Codex CLI and Claude CLI: 11
  repositories and 176 completed C0/C3 command-reported pairs per agent.
- The resource-bounded dry-runs and non-dry-run reports show no implicit timeout
  parameter in the formal protocol.
- The original broad Codex run failed on an oversized repository with Node heap
  OOM and is not used as claim evidence.

Patent-facing language may now use the resource-bounded Codex/Claude main as
command-reported C0/C3 evidence. It must not describe it as provider billing,
human outcome evidence, or a four-condition C0-C3 live trajectory study.
