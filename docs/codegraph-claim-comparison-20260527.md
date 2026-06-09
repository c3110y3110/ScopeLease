# CodeGraph-Style Context Claim Comparison

Date: 2026-05-27

This note is a protocol boundary, not a reusable numeric result. It defines how graph-based retrieval and live paired-agent evidence must be separated before any current efficiency claim is reported.

## Why this Protocol Exists

Recent code-graph tools usually justify efficiency by comparing a broad code exploration path with a graph-selected context path. That style of claim is useful, but it is not the same as provider billing, hidden reasoning-token usage, or actual Codex default behavior.

ScopeLease should therefore compare graph-assisted retrieval under named, repeatable conditions:

- broad keyword or file-search exploration versus graph-selected frontier files
- graph-selected frontier files versus ScopeLease compact prompt context
- actual paired agent runs, when Codex or Claude is available, with the same `workIntent` and `pairId`
- permission and review-boundary checks alongside token or call reductions

## Current Boundary

The graph benchmark command exists and can be rerun:

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js graph-bench . \
  --tasks examples/evaluation/codegraph-claim-tasks.jsonl \
  --format json
```

The command separates four measurements:

| Column | Meaning | Claim boundary |
| --- | --- | --- |
| `grep` | keyword search plus reading matched files | naive exploration baseline |
| `codeGraphMinimalFiles` | asserted minimal graph file set from the task manifest | CodeGraph-style controlled lower bound |
| `graphFrontierFiles` | files selected by ScopeLease task terms plus graph frontier | current ScopeLease graph retrieval behavior |
| `scopeleasePromptTokens` | compact ScopeLease agent prompt without full file bodies | prompt candidate, not file-read equivalence |

Do not report a graph-bench token percentage as "real Codex savings" unless it is paired with a same-task Codex or Claude run. Graph-bench is a diagnostic for retrieval precision and call reduction, not a provider or live-agent billing record.

## Interpreting Results

Use the following wording when a fresh graph-bench result is produced:

> In a controlled CodeGraph-style exploration protocol, ScopeLease reduced the number of candidate files or calls relative to a broad search baseline while preserving the declared task frontier. This is a retrieval-efficiency result, not a provider-billing result and not a claim about Codex default context construction.

Use the following wording only after paired Codex or Claude runs exist:

> In same-work-intent paired agent runs, the C3 full ScopeLease lane used fewer observed agent-visible context tokens or fewer command-reported tokens than the C0 baseline lane, while satisfying the permission and review-boundary checks.

If the paired result is missing, negative, or quality checks fail, report that directly. ScopeLease may still have a patentable implementation, but the efficiency effect is not current evidence for that run.

## Product Implication

The stronger product and patent claim is not "ScopeLease has a better code graph than every CodeGraph tool." It is:

> ScopeLease can consume repo-local KG or CodeGraph-like payloads, reduce them into compact review and permission frontiers, bind those frontiers to signed approval leases, and measure whether the same work intent used fewer context tokens, fewer tool calls, and fewer repeated approval prompts.

This distinction matters for CHI and patent review. The novelty is the combined delegation boundary: graph-scoped context, signed scopeleaserity, measurable agent-visible input, and review-frontier preservation.

## Rerun Checklist

```bash
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js graph-bench . \
  --tasks examples/evaluation/codegraph-claim-tasks.jsonl \
  --format json

SCOPELEASE_DISABLE_TIKTOKEN=1 node scripts/run-formal-command-eval.mjs \
  --repos-file examples/evaluation/formal-command-repos.example.json \
  --tasks examples/evaluation/official-fresh-run-tasks.example.jsonl \
  --agent-preset codex \
  --repeat 3 \
  --output .scopelease/experiments/fresh-codex

SCOPELEASE_DISABLE_TIKTOKEN=1 node scripts/run-formal-command-eval.mjs \
  --repos-file examples/evaluation/formal-command-repos.example.json \
  --tasks examples/evaluation/official-fresh-run-tasks.example.jsonl \
  --agent-preset claude \
  --repeat 3 \
  --output .scopelease/experiments/fresh-claude

SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js permission-fixtures . --run --format json
SCOPELEASE_DISABLE_TIKTOKEN=1 node src/cli.js review-bench . \
  --tasks examples/evaluation/patent-paper-review-frontier-tasks.jsonl \
  --max-frontier-files 24 \
  --format json

SCOPELEASE_DISABLE_TIKTOKEN=1 npm test
npm run desktop:check
```
# Archival Note

This is an older analysis snapshot. Do not use its numeric results as current source-of-truth evidence. Current evidence is in `docs/delegation-control-evaluation-summary.md`, `docs/current-research-memory.md`, and `.scopelease/reports/delegation-control-source-of-truth-20260528/`.
