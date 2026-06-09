# Literature-Grounded Evaluation Taxonomy

This document is a task taxonomy and evaluation-design note. It deliberately
does not contain prior token-saving numbers. Current numeric claims must
come from a fresh run snapshot.

## Position

ScopeLease should be evaluated as a scoped delegation layer for coding agents:

> Given the same user request and repository, does the C3 full ScopeLease agent
> complete the task with less irrelevant context, fewer unnecessary calls, a
> smaller review frontier, and fewer human permission decisions while preserving
> task correctness and boundary safety?

This is the claim boundary for both patent evidence and CHI-style evaluation.

## Task Sources

Use task families that reviewers can recognize instead of only hand-written
toy tasks.

| Family | Why it is relevant | ScopeLease mechanism tested |
| --- | --- | --- |
| SWE-style maintenance tasks | Realistic codebase navigation, bug fixing, and tests | readPlan, review frontier, completion quality |
| Terminal-Bench-style command tasks | Shell commands, setup, validation, and failure handling | command scope, safe command classification, call count |
| MLE-bench/MLE-like tasks | Data/ML pipelines, provenance, metric validation | expert context narrowing, trace ledger, completion attempts |
| Security/permission adversarial tasks | Path escape, network, destructive command, checkpoint risk | guard, signed lease, deny/ask routing |
| Repository onboarding tasks | Non-expert explanation and setup decisions | plain-language decision surface, context boundary |
| Architecture/review tasks | Code review focus, dependency paths, missed or irrelevant files | review-frontier correctness and leakage |

## Participant or Persona Strata

For automated evaluation, persona means task type and expected evidence, not a
human subject.

| Stratum | Representative work | Primary metrics |
| --- | --- | --- |
| Professional developer | fix, refactor, test, review, issue triage | pass rate, attempts, command tokens, file reads, review frontier |
| General repository user | setup, explain, approve safe next step | decision prompts, plain-language correctness, command safety |
| ML/data expert | pipeline debug, metric verification, result provenance | completion, attempts, context/call count, trace evidence |
| Security/reviewer | permission boundary, command/path risk | false allow, false deny, lease hit, deny, stop condition |

## Required Pair Design

Every quantitative result must be a same-task pair:

```text
same repository
same task id
same workIntent
same pairId
same agent family
same model/settings where observable
condition A: no ScopeLease hook
condition B: ScopeLease hooked
```

The default lane is not a manually constructed "full repository prompt." It is
the actual C0 baseline agent run under the same task. The C3 full ScopeLease lane is the same
agent with ScopeLease context, guard, and scoped workspace behavior enabled.

## Seven Evaluation Axes

| Axis | Question | Automated metric | CHI/human-study complement |
| --- | --- | --- | --- |
| Completion | Did it solve the task? | pass/fail, tests, attempts to pass, timeout | perceived success and trust |
| Context efficiency | Did the agent receive less irrelevant context? | prompt/context tokens, scoped files, omitted irrelevant nodes | perceived information overload |
| Call efficiency | Did the agent need fewer tool/file calls? | tool calls, reads, greps, command calls, repeated calls | perceived waiting and interruption |
| Permission delegation | Did ScopeLease reduce repeated permission decisions? | ask count, lease hit, deny, stop condition, false allow/block | decision workload and confidence |
| Review frontier | Did it reduce what a person must review? | required files covered, irrelevant files excluded, missed files, leakage | review effort and missed-risk perception |
| Boundary safety | Did it prevent scope creep? | out-of-scope edit/read, destructive/network denial, checkpoint gating | perceived control and reversibility |
| Intent coherence | Did it avoid mixing unrelated goals? | merged intent count, intent mismatch, unrelated edits | human judgment of whether the agent stayed on task |

## Fresh-Run Evidence Rule

Each report must include:

- task manifest;
- repository manifest;
- agent version and plan information where available;
- C0 baseline and C3 full ScopeLease artifacts for every pair;
- exact metric boundary;
- all failed, timeout, invalid, negative, and overhead pairs;
- aggregate and per-category results;
- explicit statement that provider billing is excluded unless captured.

The current schema is
`examples/evaluation/fresh-run-snapshot.schema.json`.

## CHI Fit

The strongest CHI framing is not "a graph reduces tokens." The stronger HCI
framing is:

> ScopeLease changes the human role from repeatedly approving low-level agent
> actions to reviewing a bounded delegation scope, exception cases, and a
> smaller evidence frontier.

Automated fresh runs can support the technical substrate. A CHI submission
still needs a human study for workload, trust calibration, and review effort.
