# Review-Frontier Correctness

Review-frontier evaluation answers one narrow question:

> If ScopeLease reduces the files a person or agent must inspect, does it still keep the critical files, symbols, policies, scope hashes, and expected permission intent?

It is not a human review-time study and not provider billing evidence.

## Current Fixture

Run:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js review-bench . \
  --tasks examples/evaluation/patent-paper-review-frontier-tasks.jsonl \
  --max-frontier-files 24 \
  --format json
```

Current source-of-truth verification:

```text
tasks: 23
passed: 23
failed: 0
baseline review files: 1,631
ScopeLease review frontier files: 552
review-scope reduction: 66%
critical file recall: 100%
critical symbol recall: reported by current `review-bench`
precision/token proxy: covered critical files and symbols per 1k rough file-read tokens
```

## Quality Axes

| Axis | Required meaning |
| --- | --- |
| omission | critical files, symbols, and policy hits are not missed |
| precision/token | critical file/symbol precision and covered critical items per rough token are reported |
| leakage | local/generated/private state is not exposed as review context |
| merge boundary | request, graph, and baseline scope hashes remain present |
| intent alignment | observed guard verdict and action grant match the task boundary |
| acceptance | the frontier can support the requested review task |
| regression evidence | relevant tests/docs/config are retained |
| oracle validity | task fixture has gold files, expected guard result, and action metadata |
| trajectory | trace ledger connects request, frontier, and decision |
| permission policy | expected policy hits remain visible |
| stop/completion | stop conditions remain visible |
| contamination | gold fixture labels are not leaked into the prompt |
| minimality | frontier stays under the configured cap |
| reliability | graph and baseline hashes are present |

## Claim Boundary

Safe:

> In a controlled 23-task review-frontier fixture, ScopeLease reduced broad review candidates while preserving the automated omission/leakage/merge/intent quality boundary.

Safe with the same boundary:

> ScopeLease reports symbol-level frontier recall/precision and a rough precision/token proxy for the named fixture. This is local file-read/prompt proxy evidence, not provider billing.

Unsafe:

> Human review time fell by the same percentage.

Human review-time and workload claims require the CHI user study.
# Archival Note

This is an older analysis snapshot. Do not use its numeric results as current source-of-truth evidence. Current evidence is in `docs/delegation-control-evaluation-summary.md`, `docs/current-research-memory.md`, and `.scopelease/reports/delegation-control-source-of-truth-20260528/`.
