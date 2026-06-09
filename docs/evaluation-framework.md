# ScopeLease Evaluation Framework

This document replaces old run-number based evaluation notes. Current claims must be produced from a fresh frozen snapshot. Do not reuse older averages as current evidence.

## Research Position

ScopeLease should be evaluated as a scoped-delegation layer for AI coding agents:

> ScopeLease narrows the context and review boundary for a coding task, binds delegated scopeleaserity to a signed approval lease, and re-asks only when the task crosses a file, command, risk, baseline, graph, or stop-condition boundary.

This is not a pure token-compression paper. It is also not a pure code graph paper. The evaluation must show that reduced context does not damage completion, safety, or review quality.

## Claim Axes

| Axis | Question | Patent use | CHI/paper use |
| --- | --- | --- | --- |
| A. Task completion (`A_task_completion`) | Does the task still complete? | Shows the technical effect is not achieved by breaking the workflow | Non-inferiority or success-rate result |
| B. Context/call efficiency (`B_context_call`) | Does ScopeLease reduce command tokens, prompt bytes, tool calls, file frontier, or duration? | Technical effect | Quantitative efficiency result |
| C. Permission/delegation correctness (`C_permission_delegation`) | Does guard/lease/enforce make correct allow/ask/deny decisions? | Core invention evidence | Safety/calibration result |
| D. Review-boundary quality (`D_review_boundary`) | Does narrowing avoid omission, leakage, merge-boundary, and intent failures? | Boundary-preservation evidence | Quality-control result |
| E. Silent-failure trajectory (`E_silent_failure`) | Do trajectory logs expose omission, leakage, scope drift, intent drift, merge drift, unsafe calls, unnecessary calls, and escalation errors? | Boundary-preservation evidence | Delegation failure analysis |
| F. Human supervision (`F_human_supervision`) | Do users understand and decide better with ScopeLease? | Optional support, not required for filing | Required for CHI-style contribution |
| G. Ablation (`G_ablation`) | Do C0/C1/C2/C3 isolate context, guard, signed lease, and full ScopeLease effects? | Mechanism decomposition | Contribution decomposition |

## Formal Fresh-Run Unit

One unit is a paired run:

```text
same benchmark task
same repository snapshot
same model family and resource budget
same workIntent
same pairId
default-agent lane without ScopeLease
scopelease-agent lane with ScopeLease context/frontier/lease
same verifier or task-specific success criterion
```

Each pair must keep negative rows, timeout rows, missing-context rows, and overhead rows.

## Agent Baselines

| Condition | Meaning |
| --- | --- |
| C0 baseline | Agent command/app flow without ScopeLease context, ScopeLease hook, ScopeLease MCP, or approval lease |
| C1 context only | ScopeLease decision card, read frontier, and review frontier without guard or signed lease |
| C2 guard only | ScopeLease guard/hook without context card or reusable signed lease |
| C3 full ScopeLease | graph frontier plus signed lease plus stop conditions plus metering |

For a CHI paper, C1 is important because it separates "better context retrieval" from "better human delegation boundary." C2 is important because it separates local guard behavior from reusable signed delegation.

## Official Task Sources

Use official or official-style task snapshots as workload sources, not as a claim that ScopeLease improves benchmark score.

| Family | Use | Primary result |
| --- | --- | --- |
| SWE-style / SWE-bench Pro style | software maintenance and regression tasks | completion, token/call, review frontier |
| Terminal-Bench style | terminal, command, service, and verifier tasks | command safety, stop condition, completion |
| MLE-bench / MLE-like | ML engineering workflows | long-context pipeline, data, training, submission boundary |
| ScopeLease adversarial fixtures | cases official benchmarks do not cover | permission false allow/block, lease invalidation |

SWE-bench Verified should not be a headline capability benchmark because public benchmark contamination and grading concerns are now well known. If used, treat it as a workload source only.

## Metrics

### A. Completion

Record:

- official verifier pass/fail
- unit/test pass/fail
- MLE score or submission validity where applicable
- attempts to completion
- timeout
- failure reason

Claim threshold: ScopeLease must preserve completion within a predefined non-inferiority margin, for example 5 percentage points, or report the deficit.

### B. Context/Call Efficiency

Record:

- `default_command_tokens`
- `scopelease_command_tokens`
- `default_prompt_bytes`
- `scopelease_prompt_bytes`
- `default_tool_calls`
- `scopelease_tool_calls`
- `default_duration_ms`
- `scopelease_duration_ms`
- positive pairs, overhead pairs, timeout pairs

Report weighted mean, macro mean, median, and family-level distributions. Do not report provider billing unless paired provider usage exists for both lanes.

### C. Permission/Delegation Correctness

Record:

- expected guard verdict accuracy
- hard-deny false allow count
- false block count
- lease issued count
- lease hit count
- lease invalidation count
- stop condition prompts
- pre-execution block count

Patent-safe threshold: hard-deny false allow must be zero for the reported fixture family.

### D. Review-Frontier Quality

Record:

- critical file recall
- critical symbol recall
- critical file and symbol precision
- covered critical files/symbols per 1k rough frontier tokens
- policy recall
- leakage count
- merge-boundary failures
- intent-alignment failures
- contamination failures
- frontier file count vs broad baseline file count

A reduction is claim-ready only if the quality boundary passes. Precision/token is a local frontier-quality proxy; it must not be reported as provider billing or human review time.

### E. Silent-Failure Trajectory

Record:

- omission count
- leakage count
- scope drift count
- intent drift count
- merge drift count
- unsafe call count
- unnecessary call count
- escalation error count

Report these separately rather than hiding them inside a composite score. A token or call reduction is not claim-ready if these failures increase without explanation.

### F. Human Supervision

For CHI, run a controlled user study. Automated proxy counters are not enough.

Conditions:

1. native agent approval prompt
2. graph/context-only summary
3. ScopeLease decision card plus review frontier plus signed lease

Measures:

- delegation decision accuracy
- unsafe allow rate
- out-of-scope detection
- decision time
- repeated prompt count
- comprehension of what the agent may do
- perceived control
- trust calibration
- NASA-TLX or short workload scale

Only this study can support human cognitive-load or fatigue claims.

### G. Ablation

Record C0, C1, C2, and C3 separately:

- C0 baseline: no ScopeLease context, guard, hook, MCP, or lease
- C1 context only: decision card and read/review frontier only
- C2 guard only: guard/hook without context card or reusable signed lease
- C3 full ScopeLease: context, review frontier, guard, signed lease, stop frontier, and metering

Do not report controlled C0-C3 boundary pass as live task completion. Live completion requires actual paired agent runs under fixed agent, model, budget, verifier, timeout, and retry policy.

## Fresh-Run Commands

Codex formal run:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node scripts/run-formal-command-eval.mjs \
  --repos-file .scopelease/evaluation/fresh-run-repos.json \
  --tasks examples/evaluation/official-fresh-run-tasks.example.jsonl \
  --repeat 2 \
  --min-repos 10 \
  --min-pairs 100 \
  --default-agent codex \
  --scopelease-agent codex \
  --run-id-prefix formal-fresh-codex-YYYYMMDD-HHMMSS
```

Canonical report regeneration:

```bash
npm run paper:report
```

Claude formal run:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node scripts/run-formal-command-eval.mjs \
  --repos-file .scopelease/evaluation/fresh-run-repos.json \
  --tasks examples/evaluation/official-fresh-run-tasks.example.jsonl \
  --repeat 2 \
  --min-repos 10 \
  --min-pairs 100 \
  --default-agent claude \
  --scopelease-agent claude \
  --run-id-prefix formal-fresh-claude-YYYYMMDD-HHMMSS
```

Automated boundary checks:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 npm test
npm run desktop:check
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js permission-fixtures . --run --format json
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js review-bench . \
  --tasks examples/evaluation/patent-paper-review-frontier-tasks.jsonl \
  --max-frontier-files 24 \
  --format json
```

## Claim Wording

Use only after a fresh run passes thresholds:

> Under a frozen-source, paired official-task protocol, ScopeLease preserved task completion while reducing command-reported context/tool-call overhead and preserving permission and review-boundary checks.

Use when token results are mixed:

> ScopeLease's permission and review-boundary mechanisms were verified, but the formal token/call run showed mixed or negative deltas. We report the signed deltas and failure modes rather than an average-savings claim.
