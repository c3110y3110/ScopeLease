# Re-Evaluation Plan For The Latest ScopeLease Implementation, 2026-05-27

This plan defines the current evidence posture. Current effect claims require a fresh run after the latest guard, lease, network-command, and documentation changes.

## Principle

Evaluate the current implementation as a frozen system. Do not mix prior pair runs, prior fixture counts, or prior controlled prompt outputs into current averages.

This plan now has a companion expansion for patent and paper use:

- `docs/patent-paper-evaluation-expansion-20260527.md`
- `examples/evaluation/patent-paper-review-frontier-tasks.jsonl`

The split is intentional. Patent evidence should emphasize concrete mechanism, boundary conditions, and reproducible technical effects. Paper evidence should additionally report baseline choice, task taxonomy, ablations, failure cases, and statistical distribution. Human participant fatigue data is not available yet, so item E is a study plan only.

## A-E Evaluation Scope

| Item | Current status | Patent use | Paper use |
| --- | --- | --- | --- |
| A. Context/token/call reduction | Run fresh command/pair protocol | Technical effect of scoped context and graph frontier | Main quantitative outcome with baselines, repetitions, and failure distribution |
| B. Permission/enforcement correctness | Run current fixtures and adversarial cases | Supports signed approval lease, invalidation, and stop-condition claims | Safety/correctness outcome with false allow/false block reporting |
| C. Decision-load proxy | Run scripted replay counters | Supports reduced repeated scopeleaserization prompts, not psychological fatigue | Secondary proxy outcome; human data still absent |
| D. Review-frontier quality | Run omission/leakage/merge/intent benchmark | Shows context narrowing keeps critical review boundaries | Quality-preservation outcome and ablation target |
| E. Human participant study | Plan only | Not needed for core patent filing | Future HCI validation only; no current effect claim |

## Freeze Step

Before measuring effects:

1. Record the source snapshot hash or archive name.
2. Run `SCOPELEASE_DISABLE_TIKTOKEN=1 npm test`.
3. Run `npm run desktop:check`.
4. Run `SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js permission-fixtures . --run --format json`.
5. Create a new run prefix such as `formal-current-20260527-<hhmmss>`.

If any of these fail, stop and do not run effect claims.

## Axis 1: Context, Token, And Call Reduction

| Item | Protocol |
| --- | --- |
| Unit of comparison | Same repository, same task, same work intent, paired default/ScopeLease lanes |
| Default lane | Natural request-only prompt in a copied full or filtered worktree, with ScopeLease-specific rules removed |
| ScopeLease lane | Same task with ScopeLease readPlan/scoped worktree and current approval/guard context |
| Primary metric | Codex CLI command-reported `tokens used` |
| Secondary metric | Wall-clock duration, observed prompt bytes, tool-call count |
| Required sample | 10-20 repositories, about 100 measured pairs |
| Claim threshold | Positive weighted delta, positive macro mean, positive pairs greater than overhead pairs |
| Failure reporting | Keep overhead pairs, timeout pairs, review-needed pairs, and missing-context signals visible |

Do not report provider billing. Do not report full repository size as savings. Do not treat copied file count as actual file-read tracing.

## Axis 2: Permission And Enforcement

| Item | Protocol |
| --- | --- |
| Fixture run | Current 12-fixture suite must pass 12/12 |
| Additional adversarial cases | Add fresh cases for Bash network commands, command substitution, pathless writes, out-of-scope apply_patch, checkpoint, and scope expansion |
| Execution surface | Test both `scopelease guard` decision and connected `scopelease enforce` / `guarded-exec` pre-execution blocking |
| Primary metric | Expected verdict match rate |
| Secondary metric | False allow, false block, lease hit, hard deny, ask_once |

Safe claim requires no false allow on hard-deny cases.

## Axis 3: Decision-Fatigue Proxy

| Item | Protocol |
| --- | --- |
| Proxy unit | Decision prompt opportunity, lease hit, repeated question suppressed, stop condition |
| Comparison | Native/guard-only flow vs ScopeLease signed scoped lease flow |
| Current minimum | Replay study over scripted workflows, even without human participants |
| Stronger version | Human study with time-to-decision, NASA-TLX or short workload scale, override rate, trust calibration |
| Claim boundary | Prompt reduction proxy only unless human data exists |

Do not claim psychological fatigue reduction from fixture counters alone.

## Axis 4: Review Reduction And Quality

| Item | Protocol |
| --- | --- |
| Comparison | Grep/read broad exploration vs graph/review frontier |
| Quality axes | Omission, leakage, merge-boundary consistency, intent alignment, acceptance, regression evidence, oracle validity, contamination, minimality |
| Required output | Per-task included files, missed critical files, leaked unrelated files, quality pass/fail |
| Claim threshold | Reduced review set with critical recall preserved and no required quality-axis failure |

This answers whether context narrowing makes review smaller without silently missing important files.

For patent/paper expansion, use the broader executable fixture:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js review-bench . \
  --tasks examples/evaluation/patent-paper-review-frontier-tasks.jsonl \
  --max-frontier-files 24 \
  --format json
```

This fixture is not a human review-time study. It checks whether a reduced graph-derived review frontier preserves critical files, symbols, policies, scope hashes, expected guard decisions, and quality boundaries.

## Axis 5: Generalization

Use task categories instead of one-off examples:

| Stratum | Example task types |
| --- | --- |
| Professional developer | bug localization, architecture review, test validation, config review |
| General repository user | README/setup, dependency/config orientation, simple issue triage |
| Security/permission reviewer | network command review, path escape, lease reuse, checkpoint |
| ML/data expert | pipeline inspection, data artifact validation, metric/provenance check |

Report results by category. Do not collapse category failures into one average.

## Output Artifacts

The fresh run should produce:

| Artifact | Purpose |
| --- | --- |
| `product-wide-summary.json` | Average token/call/duration results |
| `claim-ready-report.json` | Claim status and boundaries |
| `permission-fixtures.jsonl` and run summary | Permission correctness |
| `review-frontier-report.json` | Review reduction and quality |
| `decision-proxy-report.json` | Prompt/lease/stop-condition counters |
| `README-current-evaluation.md` | Plain-language summary |

For a patent handoff, include the implementation mapping and claim-boundary table. For a paper submission, include all raw rows, negative rows, timeout rows, and per-category distributions.

## How To Word The Result

If the fresh run passes thresholds:

> In the current frozen implementation and named evaluation protocol, ScopeLease reduced Codex CLI command-reported tokens by X% across N repositories and M paired tasks, while preserving the stated automated quality boundary and passing the permission fixture suite.

If it does not:

> The current implementation provides the signed approval and scoped context mechanism, but the latest evaluation did not support an average token-saving claim. Report the signed delta, overhead categories, and failure modes.
# Archival Note

This is an older analysis snapshot. Do not use its numeric results as current source-of-truth evidence. Current evidence is in `docs/delegation-control-evaluation-summary.md`, `docs/current-research-memory.md`, and `.scopelease/reports/delegation-control-source-of-truth-20260528/`.
