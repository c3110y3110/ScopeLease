# ScopeLease Live Experiment Readiness Record

Updated: 2026-06-08 KST. Scope: non-human measurements only. Human supervision study results are intentionally excluded.

This document records what is actually runnable or measured in the current workspace. It now treats the resource-bounded Codex and Claude formal local main runs as completed C0/C3 command-reported protocols, while keeping human supervision claims out of scope.

## Current Verified Status

| Item | Current result | Claim status |
| --- | ---: | --- |
| Unit/integration tests | `npm test`: 94 pass, 0 fail, 0 skip | implementation sanity check |
| Codex CLI | `/usr/local/bin/codex`, `codex-cli 0.137.0` | runnable in this shell |
| Claude CLI | shell `PATH` check is empty, but the harness resolves local install candidates including `$HOME/.local/bin/claude` | runnable through the harness; `SCOPELEASE_CLAUDE_BIN` remains an optional override |
| Codex live pilot dry-run | 1 repo, 4 expected pairs, `repoTimeoutMs:0`, `commandTimeoutMs:0` | ready |
| Claude live pilot dry-run | 1 repo, 4 expected pairs, `repoTimeoutMs:0`, `commandTimeoutMs:0` | ready |
| Codex resource-bounded formal main | 11 repos, 176 pairs, `11,830,597 -> 3,879,686` command-reported tokens | claim-ready for this C0/C3 command-reported protocol |
| Claude resource-bounded formal main | 11 repos, 176 pairs, `49,656,538 -> 21,824,362` command-reported tokens | claim-ready for this C0/C3 command-reported protocol |
| Codex live pilot | passed in 707.6s, 4/4 pairs measured | pilot claim only |
| Claude live pilot | passed in 1,064.5s, 4/4 pairs measured | pilot claim only |

The runner no longer applies an implicit command timeout. `SCOPELEASE_RUNNER_TIMEOUT_MS`, `--repo-timeout-ms`, and `--command-timeout-ms` are absent from the paper scripts unless explicitly supplied by an operator.

The Claude adapter now resolves `SCOPELEASE_CLAUDE_BIN` first and then local install candidates such as `$HOME/.local/bin/claude`; the shell `PATH` check is diagnostic only.

## Codex Live Pilot: Current Measurement

Command:

```bash
npm run paper:live-pilot:codex
```

Evidence:

```text
.scopelease/experiments/pilot-codex-main-20260607/
.scopelease/experiments/pilot-codex-main-20260607-scopelease-paper/
```

Summary:

| Metric | Result |
| --- | ---: |
| repositories | 1 |
| same-workIntent pairs | 4 |
| lane commands | 8/8 passed |
| lane timeouts | 0 |
| run duration | 707,563 ms |
| command-reported source | `codex_cli_stderr_tokens_used` |
| command-reported tokens | 370,894 -> 281,438 |
| weighted token delta | 24% lower |
| macro token delta | 20% lower |
| median token delta | 28% lower |
| positive / overhead pairs | 3 / 1 |
| decision-prompt proxy | 456 -> 4, 99% lower |
| command duration proxy | 363,047 ms -> 339,612 ms, 6% lower |
| heuristic command-quality pass lanes | 5/8; score 90.63% |
| task-specific completion rubric | not configured |

Per task:

| Task type | C0 tokens | C3 tokens | Delta |
| --- | ---: | ---: | ---: |
| architecture_review | 133,372 | 71,575 | 46% lower |
| test_validation | 74,363 | 92,146 | 24% overhead |
| permission_workflow | 82,807 | 68,798 | 17% lower |
| ambiguous_requirement | 80,352 | 48,919 | 39% lower |

Claim boundary:

- Claimable: the Codex live runner and command-reported metering path work on this 1-repo/4-pair pilot, with no timeouts and with a positive aggregate command-reported token delta.
- Not claimable: formal product-wide average, official benchmark success improvement, provider billing reduction, or task-quality improvement. The pilot is below the 10-repository/100-pair formal floor and has no task-specific completion rubric.

## Claude Live Pilot: Current Measurement

Command:

```bash
npm run paper:live-pilot:claude
```

Evidence:

```text
.scopelease/experiments/pilot-claude-main-20260607/
.scopelease/experiments/pilot-claude-main-20260607-scopelease-paper/
```

Result:

| Metric | Result |
| --- | ---: |
| harness process | passed |
| repositories | 1 |
| same-workIntent pairs | 4 |
| lane commands | 8/8 passed |
| lane timeouts | 0 |
| run duration | 1,064,526 ms |
| command-reported source | `claude_cli_json_usage` |
| command-reported tokens | 2,304,719 -> 1,674,373 |
| weighted token delta | 27% lower |
| macro token delta | 22% lower |
| median token delta | 37.5% lower |
| positive / overhead pairs | 3 / 1 |
| decision-prompt proxy | 456 -> 4, 99% lower |
| command duration proxy | 632,181 ms -> 426,178 ms, 33% lower |
| heuristic command-quality pass pairs | 4/4; score 100% |
| task-specific completion rubric | not configured |

Per task:

| Task type | C0 tokens | C3 tokens | Delta |
| --- | ---: | ---: | ---: |
| architecture_review | 474,544 | 292,524 | 38% lower |
| test_validation | 1,145,126 | 722,869 | 37% lower |
| permission_workflow | 351,970 | 583,957 | 66% overhead |
| ambiguous_requirement | 333,079 | 75,023 | 77% lower |

Claim boundary:

- Claimable: the Claude live runner, local CLI resolution, and `claude_cli_json_usage` command-reported metering path work on this 1-repo/4-pair pilot, with no timeouts and with a positive aggregate command-reported token delta.
- Not claimable: formal product-wide average, provider billing reduction, task-quality improvement, or broad Claude generalization. The pilot is below the 10-repository/100-pair formal floor and has no task-specific completion rubric.

Historical note: `.scopelease/experiments/claude-pilot5/` remains an earlier Claude pilot artifact. The current `pilot-claude-main-20260607` run supersedes the failed shell-PATH rerun state and should be used for current Claude pilot wording.

## Resource-Bounded Formal Main Status

The original unbounded local-main attempt remains a superseded runner/resource
failure note. The current result-bearing protocol is the resource-bounded local
main using `.scopelease/evaluation/formal-live-local-repos-resource-bounded.json`.
It excludes the oversized `ai-research-os` repository as `over_resource_bound`,
deduplicates labels, excludes virtualenv/site-packages trees, and keeps the
formal timeout policy at `repoTimeoutMs:0` and `commandTimeoutMs:0`.
In the local workspace, the resource-bounded manifests point at existing local
repositories and the dry-runs pass. In an anonymous clean source package, any
sanitized or missing local repository paths are not treated as ready: dry-run
metadata reports `runnableInCurrentPackage:false` and exits nonzero until the
manifest is regenerated for that machine.

| Agent | Status | Repos | Pairs | Command-reported tokens | Weighted / macro / median | Positive / overhead |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Codex | `claim_ready` | 11 | 176 | 11,830,597 -> 3,879,686 | 67% / 59% / 71% lower | 161 / 15 |
| Claude | `claim_ready` | 11 | 176 | 49,656,538 -> 21,824,362 | 56% / 38% / 52.5% lower | 156 / 20 |

Evidence:

```text
.scopelease/experiments/formal-local-main-codex-resource-bounded/product-wide-summary.json
.scopelease/reports/formal-local-main-codex-resource-bounded/claim-ready-report.md
.scopelease/experiments/formal-local-main-claude-resource-bounded/product-wide-summary.json
.scopelease/reports/formal-local-main-claude-resource-bounded/claim-ready-report.md
```

Claim boundary: these are same-workIntent C0/C3 command-reported local-main
results. They are not provider billing, not hidden-reasoning usage, and not a
four-condition C0/C1/C2/C3 trajectory result.

## C0-C3 Boundary

Current resource-bounded broad local live runner emits C0 and C3 lanes:

| Condition | Current broad live support |
| --- | --- |
| C0 | baseline agent, no ScopeLease |
| C1 | not emitted by broad local live runner |
| C2 | not emitted by broad local live runner |
| C3 | ScopeLease context/frontier + scoped workspace + preapproval lease path |

Controlled C0-C3 mechanism evidence exists separately through the delegation report and condition matrix. A CHI Study 1 that claims broad four-condition live C0-C3 trajectory evidence still needs C1 and C2 live lanes or a preregistered public panel that records all four conditions.

## Claim Policy

Allowed now:

- controlled mechanism and frontier claims from frozen evidence;
- Codex 2026-06-07 pilot feasibility and bounded command-reported deltas;
- Claude 2026-06-07 pilot feasibility, local binary resolution, and bounded command-reported deltas;
- resource-bounded Codex/Claude formal local-main C0/C3 command-reported results;
- historical Claude pilot only with its artifact label and historical boundary.

Not allowed now:

- the superseded 2026-06-07 attempted Codex formal main as completed evidence;
- broad live four-condition C0-C3 generalization;
- provider billing reduction;
- task-quality improvement from pilot runs without task-specific completion rubrics;
- human fatigue, workload, trust, perceived-control, or decision-accuracy claims.
# Current Non-Human Evidence Status (2026-06-08)

This note supersedes earlier wording in this file that marked the broad
resource-bounded formal live main as only prepared.

Latest verification snapshot:

- `npm test`: 94/94 pass, 0 skipped, 0 failed.
- `npm run desktop:check`: pass.
- `npm run paper:verify:frozen`: pass.
- `npm run paper:source-truth-check`: pass.
- `scopelease_clean_source.zip`: verified under the 512 MB cap with 340 entries,
  279 text files checked, leaks `[]`.
- CLI availability: Codex resolves at `/usr/local/bin/codex` with
  `codex-cli 0.137.0`; Claude is resolved by the harness through its local
  install search path for the completed main run.

Claimable completed evidence:

- Frozen controlled source-of-truth evidence is verified.
- Controlled C0-C3 mechanism evidence is verified.
- Same-prompt selected Terminal-Bench panel evidence is documented as completion
  and overhead evidence, not as token-saving evidence.
- Codex CLI one-repository live pilot is complete and documented.
- Claude CLI one-repository live pilot is complete and documented.
- Codex resource-bounded formal local main is complete: 11 repositories, 176
  same-workIntent pairs, command-reported total tokens `11,830,597 ->
  3,879,686`, `67%` weighted lower, `59%` macro lower, `71%` median lower,
  `161` positive and `15` overhead pairs.
- Claude resource-bounded formal local main is complete over the same manifest:
  11 repositories, 176 same-workIntent pairs, Claude CLI JSON usage-reported
  total tokens `49,656,538 -> 21,824,362`, `56%` weighted lower, `38%` macro
  lower, `52.5%` median lower, `156` positive and `20` overhead pairs.

Protocol details:

- Resource-bounded formal local main manifest:
  `.scopelease/evaluation/formal-live-local-repos-resource-bounded.json`.
- The manifest includes 11 local repositories, meets the `minRepos=10` gate,
  and yields 176 expected pairs per agent with the current common task set.
- Both Codex and Claude resource-bounded dry-runs pass in the measured local
  workspace and the non-dry-run commands completed.
- Dry-runs report `repoTimeoutMs: 0` and `commandTimeoutMs: 0`; no hidden
  300,000 ms timeout is part of the formal protocol.
- `ai-research-os` is excluded from this manifest as `over_resource_bound`
  after the original broad run hit Node heap OOM. Virtualenv and `site-packages`
  trees are excluded, and duplicate repo labels are de-duplicated.

Therefore, the honest current boundary is: all controlled/frozen evidence, both
one-repo live pilots, and both resource-bounded C0/C3 local-main studies are
done. Human evaluation is still future work. If the paper wants a broad
four-condition live C0-C3 trajectory claim, C1/C2 live lanes remain future work.
