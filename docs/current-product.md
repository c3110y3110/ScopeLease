# Current Product Boundary

ScopeLease is a repo-local sidecar for coding agents. It is not the main coding app, not a provider billing meter, and not a universal sandbox. Its job is to make delegation to Codex/Claude-style agents smaller, bounded, inspectable, and revocable.

## Current Implementation

ScopeLease implements the following pipeline:

1. Scan a repository and build a repo-local graph of files, symbols, imports, tests, docs, routes, and policy hits.
2. Compare the current repository state with the `.decision` baseline.
3. Build `readPlan`, `avoidPlan`, `traceLedger`, `symbolFrontier`, `reviewFrontier`, `permissionFrontier`, and `stopFrontier`.
4. Generate a compact agent input candidate with `agentContract` and `graphQueryHints` instead of sending the full repository or full visual graph.
5. Normalize proposed agent actions into read, patch, command, checkpoint, network, or external-write grants.
6. Evaluate `scopelease_guard`.
7. Issue an action-specific HMAC-signed approval lease only after an `ask_once` guard decision.
8. Revalidate later actions against request hash, baseline hash, risk, file scope, command scope, stop conditions, graph hashes, and lease signature.
9. Enforce pre-execution only when the host routes tools through ScopeLease hooks or `scopelease guarded-exec`; hook UI/app startup is best-effort so enforcement does not deadlock on sidecar startup.

## ScopeLease Graph Boundary

ScopeLease uses a CodeGraph-style repository graph, but the graph is a delegation boundary rather than a memory feature by itself.

```text
files/symbols/imports/tests/docs/routes/policies
  -> ScopeLease Graph
  -> graph-scoped frontiers
  -> compact agent contract
  -> guard verdict
  -> signed scope lease
```

The visual/search graph and the agent-visible context are intentionally separate:

- `analysis.knowledgeGraph` is local UI/evidence state.
- `analysis.graph` is the compact impact graph used by terminal and report views.
- `contextPack.agentContext` is the compact structured payload used in agent prompts or MCP context.
- `agentContract` states the allowed task, scope, review boundary, command boundary, and stop conditions.
- `graphQueryHints` tells the agent which graph-neighborhood questions to ask next instead of scanning the full repository.

This means ScopeLease can claim graph-scoped delegation behavior when the guard/frontier/lease path is active. It should not claim that the full graph JSON is sent to the agent by default.

## Agent Surfaces

### Codex

`scopelease attach <repo>` writes project-local Codex MCP and hook configuration under `.codex/`. The expected path is:

```text
scopelease_get_context -> inspect agentContract/graphQueryHints/readPlan -> scopelease_guard -> scopelease_approve if ask_once -> scopelease_guard again -> patch/test/report
```

Codex pair-run evaluation uses `codex exec` through the harness. The default lane runs without ScopeLease context. The ScopeLease lane runs with ScopeLease context, optional scoped worktree, and optional precreated lease.

### Claude Code-Style Agents

The harness supports a Claude preset through `claude -p < promptPath`. Claude integration is treated as an agent-command comparison unless a separate Claude hook/MCP path is wired and observed. ScopeLease still records prompt bytes, command result, pair id, work intent, and lane metadata.

### Custom Agents

Any command template can be supplied with `--agent-template`, `--default-agent-template`, or `--scopelease-agent-template`. A custom agent must receive the prompt path and run inside the supplied workspace for a valid pair.

## App Surface

The Electron app is a sidecar evidence console. It should show:

- repository attachment status
- graph frontier and decision frontier
- current request and compact agent input size
- guard verdict and approval lease status
- observed pair status
- measurement mode status

It should not become the primary coding UI. The core product is CLI/MCP/hooks plus local evidence artifacts.

## Measurement Boundary

ScopeLease separates these quantities:

| Measurement | Included | Excluded |
| --- | --- | --- |
| agent-visible input | prompt bytes and ScopeLease MCP context payloads actually supplied or recorded | hidden provider prompts, hidden reasoning, output tokens |
| command-reported tokens | total token count reported by an agent CLI command when available | provider invoice/billing unless separately ingested |
| tool/call proxy | observed PostToolUse events, file/frontier counts, command attempts | actual hidden file reads not emitted by the agent |
| precision/token proxy | critical file/symbol coverage per 1k rough local file-read or prompt tokens | provider billing, hidden reasoning, human review time |
| provider usage | only explicit paired provider usage records with lane/pair/workIntent metadata | default ScopeLease claim path |

Full repository size is not a savings baseline. It is only the search space. A savings claim requires paired default/ScopeLease evidence for the same task, same repository snapshot, same work intent, and same source boundary.

## Current Safe Claim

Safe:

> ScopeLease implements repo-local graph frontiers including symbol-level frontiers, compact agent contracts, graph-query-first hints, signed scoped approval leases, connected pre-execution enforcement points, pair-run metering, permission fixtures, and review-frontier quality checks.

Safe only for the named frozen command-reported protocol:

> In `examples/evaluation/frozen-evidence/formal-command-100pair-mini-20260521-133429/product-wide-summary.json`, the frozen 13-repository, 102-pair command-reported protocol shows 3,560,061 -> 1,280,323 command-reported total tokens, 64% lower. This is protocol-specific command output, not provider billing.

Not safe without broader live/official C0-C3 paired runs:

> ScopeLease generally reduces live Codex, Claude, Terminal-Bench, SWE-bench, SWE Atlas, or MLE-bench token usage.

Not safe from the current evidence:

> ScopeLease reduces provider/API billing, hidden prompt/reasoning tokens, or natural agent workspace access cost.

Not safe without a human study:

> ScopeLease currently reduces human cognitive fatigue.

## Current Verification Snapshot

The current local implementation has been rechecked after the ScopeLease rename:

- `npm test`: 95/95 pass, 0 fail, 0 skipped in the current verification environment
- `npm run desktop:check`: pass
- `npm run paper:review-bench`: pass; 23/23 tasks, 1,771 -> 552 candidate files, 69% file reduction, 61% rough file-read token reduction, 100% critical-file recall, 93% critical-file recall@10
- `npm run paper:report:controlled`: pass; status `mechanism_ready_live_pairs_needed`
- `npm run paper:report:full`: pass; writes fresh sanity-check evidence to `.scopelease/reports/delegation-control-fresh/` and does not overwrite the frozen source-of-truth report
- `npm run paper:report`: pass and aliases the full report path
- `paper:report:controlled` and `paper:report:full` are split into concise `:fixtures` and `:delegation` steps so reviewer-facing runs do not dump raw fixture JSON to stdout
- `node src/cli.js source-truth-check . --format json`: pass; fresh source-of-truth and frozen evidence match on generated timestamp and headline metrics
- `npm run paper:verify:frozen`: pass
- `npm run paper:source-zip`: pass; root `scopelease_clean_source.zip` regenerated under the 512 MB cap
- `npm run paper:verify:source-zip`: pass; required evidence entries are present and no local path or user-name leaks are detected
- `npm run paper:verify:source-zip:test`: pass; extracts `scopelease_clean_source.zip` and reruns `npm test`, `paper:verify:frozen`, and `paper:source-truth-check` inside the extracted copy

The enforcement deadlock has been fixed in the current code path: ScopeLease internal control commands and sidecar startup no longer require self-approval, `apply_patch` path extraction is corrected, read-only local inspection commands are quote-aware and pipeline-aware, and safe report/check scripts are allowlisted under the active hook boundary.

Operational caveat: an already-running MCP server process can keep an older action-policy snapshot until restarted. In that case `scopelease_guard`/`scopelease_approve` from the stale MCP process may still show the older four-command scope, while the current CLI and active Codex hook path use the updated report/check allowlist. Restart or reattach the MCP server after source changes before treating MCP tool output as final.
