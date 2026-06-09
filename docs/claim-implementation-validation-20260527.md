# Claim Implementation Validation

This note maps the current ScopeLease implementation to what can be claimed. It
does not reuse older token/effect averages as current evidence.

## Current Implementation Map

| Claim axis | Implementation | Current status | Claim boundary |
| --- | --- | --- | --- |
| Repo-local graph | `src/core/indexer.js`, `src/core/frontier.js`, `src/core/graph-adapter.js` | Implemented | File, symbol, import, test, doc, route, and policy graph, not a complete semantic CPG |
| Symbol-level frontier | `symbolFrontier`, `symbolProbePlan`, review-bench symbol recall/precision | Implemented | Symbol names/locations and hashes, not a full semantic slice |
| Compact context | `readPlan`, `avoidPlan`, `traceLedger`, `agentContract`, `graphQueryHints`, frontiers | Implemented | Agent-visible context boundary, not provider billing |
| Signed approval lease | `src/core/approval-lease.js` | Implemented | HMAC-signed request/baseline/risk/file/command/stop-condition lease |
| Guard decision | `src/core/guard.js`, `src/core/action-policy.js` | Implemented | Action normalization and allow/ask/deny decision |
| Pre-execution enforcement | `src/core/enforcer.js`, Codex `PreToolUse`, `scopelease guarded-exec` | Implemented for connected hosts | Only applies when the host routes tools through ScopeLease hooks or wrapper; ScopeLease control commands and sidecar startup avoid approval deadlock |
| Pair metering | `src/core/pair-harness.js`, `src/runtime/codex-usage-detector.js`, `src/core/research-calibration.js` | Implemented | Same-work-intent pairs only; hidden provider usage excluded unless separately captured |
| Review frontier | `src/core/review-bench.js`, `src/core/frontier.js` | Implemented | Measures review boundary quality, not human review effort by itself |
| Decision assistance | `src/core/fatigue-controller.js`, decision bundles, lease counters | Implemented as logs/proxies | Psychological fatigue requires a human study |

## What Is Safe To Claim Now

| Wording | Status |
| --- | --- |
| ScopeLease implements repo-local graph-based compact context generation. | Safe |
| ScopeLease provides graph-query-first hints and a compact agent contract that summarize what to read, review, change, execute, and stop on. | Safe |
| ScopeLease issues HMAC-signed scoped approval leases bound to request, baseline, risk, file scope, command scope, changed files, and stop conditions. | Safe |
| ScopeLease validates follow-up actions against the signed lease and invalidates or blocks out-of-scope actions. | Safe |
| ScopeLease can block actions before execution when the host uses ScopeLease `PreToolUse` hooks or `scopelease guarded-exec`. | Safe with connected-host boundary |
| ScopeLease separates prompt/context, command-reported, hook/MCP, and optional provider-usage metrics. | Safe |
| ScopeLease has a fresh-run protocol for Codex/Claude C0 baseline vs C3 full ScopeLease pairs, with C1/C2 ablations for context-only and guard-only effects. | Safe |
| ScopeLease has a named 13-repository, 102-pair command-reported protocol with 64% lower command-reported total tokens. | Safe only for `examples/evaluation/frozen-evidence/formal-command-100pair-mini-20260521-133429/product-wide-summary.json`; not provider billing or hidden-token savings |

## What Remains Unsafe Or Conditional

| Wording | Why not |
| --- | --- |
| ScopeLease generally reduces live Codex/Claude/Terminal-Bench token usage. | Requires larger live or official C0/C3 paired agent runs under the same model, scaffold, budget, verifier, timeout, and retry policy. |
| ScopeLease reduces provider billing. | Billing is out of scope unless provider usage is explicitly captured for both lanes. |
| ScopeLease reduces human cognitive fatigue. | Automated logs are proxies; CHI needs participant data. |
| ScopeLease is a universal sandbox. | ScopeLease is a guard/enforcement layer; host sandboxing remains separate. |

## Evidence Packet Status

This 20260527 note is archival. Do not use the numbers below as the current
artifact status. Current verification, source-zip size, fresh/frozen report
boundaries, and live Codex/Claude results are maintained in
`docs/current-product.md`, `docs/current-research-memory.md`,
`docs/live-experiment-readiness-20260607.md`, and
`docs/delegation-control-evaluation-summary.md`.

The current implementation also fixes the previously reproduced enforcement deadlock: ScopeLease internal control commands and sidecar startup no longer require self-approval, `apply_patch` path extraction is corrected, safe local reads are quote-aware and pipeline-aware, and safe local validation/report/check scripts are allowed with logging while destructive, network, external-write, checkpoint, and shell-control expansions remain gated.

## Remaining Fresh Evidence Requirement

Before using broad live-agent average effect claims, create a new snapshot with:

```text
same repository
same task id
same workIntent and pairId
same agent family
condition A: no ScopeLease
condition B: ScopeLease hooked
all failures, overhead, invalid pairs, and missing metrics retained
```

The snapshot should follow:

- `examples/evaluation/fresh-run-snapshot.schema.json`
- `docs/experimental-environment.md`
- `docs/evaluation-framework.md`

Until that snapshot exists, describe broad live Codex/Claude/benchmark savings as planned or insufficient. The named frozen command-reported protocol can be reported only with its explicit protocol boundary.
