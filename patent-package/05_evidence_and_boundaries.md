# Evidence And Boundaries

This package uses current implementation boundaries only. Older run-number snapshots are not included as current evidence. The named frozen 13-repository, 102-pair command-reported protocol is retained only as bounded command-reported evidence, not as provider billing, hidden-token, human-fatigue, or broad live-agent evidence.

## Evidence Classes

| Class | Claim supported | Required artifact |
| --- | --- | --- |
| implementation | invention is implemented | source files and mapping |
| guard/lease | scoped scopeleaserization works | guard, approve, lease-hit logs |
| enforcement | connected tools are blocked before execution | `scopelease enforce` or `guarded-exec` result |
| review frontier | narrowed review boundary preserves critical evidence | review-bench JSON |
| symbol/frontier contract | symbol-level frontier, compact agent contract, graph-query-first hints | current context/review-bench artifacts |
| pair metering | default/ScopeLease deltas are measured at the same work intent | pair-run summaries and product-wide summary |
| human study | user delegation and workload claims | participant data, not yet in this package |

## Boundaries

Safe:

- command-reported tokens for a named paired protocol
- agent-visible prompt/context bytes for a named paired protocol
- permission fixture pass/fail
- lease hit and invalidation counts
- review-frontier quality pass/fail
- completion pass/fail

Unsafe:

- provider billing reduction without paired provider usage
- universal security sandbox claim
- human fatigue claim without human study
- full repository size as a token savings baseline
- synthetic full-file prompt as natural Codex/Claude default behavior

## Fresh Evidence Checklist

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 npm test
npm run desktop:check
npm run paper:review-bench
npm run paper:report:controlled
npm run paper:report:full
npm run paper:report
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js permission-fixtures . --run --format json
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js review-bench . \
  --tasks examples/evaluation/patent-paper-review-frontier-tasks.jsonl \
  --max-frontier-files 24 \
  --format json
```

Formal pair-run evidence must use `docs/experimental-environment.md` and `docs/evaluation-framework.md`.

## Patent-Safe Summary Template

> ScopeLease implements graph-derived compact context, symbol/review/permission/stop frontiers, compact agent contracts, graph-query-first hints, action-specific guard decisions, HMAC-signed approval leases, task-scoped internal network leases, connected pre-execution enforcement points, and pair-based metering. Current command-reported efficiency claims are limited to the named frozen 13-repository, 102-pair protocol. Live agent-visible average savings, provider billing reduction, and human fatigue claims remain pending until their respective paired logs or participant data are collected.
