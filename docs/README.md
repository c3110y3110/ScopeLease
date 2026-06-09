# ScopeLease Current Documentation

This directory keeps the current patent and CHI-facing documentation only. Run-number result notes from older protocols are not kept as source-of-truth documents; fresh evidence should be regenerated through the current protocol and stored as runtime evidence.

## Read First

1. [current-research-memory.md](current-research-memory.md) - current patent/CHI framing, evidence rules, and canonical commands.
2. [chi-paper-readiness.md](chi-paper-readiness.md) - CHI-facing thesis, source-of-truth evidence, current claim boundary, and remaining paper work.
3. [current-product.md](current-product.md) - product boundary, agent surfaces, measurement boundary, and safe claims.
4. [patent-evidence-summary.md](patent-evidence-summary.md) - current patent evidence packet and claim boundaries.
5. [experimental-environment.md](experimental-environment.md) - evaluation setup for C0/C1/C2/C3 agent lanes.
6. [evaluation-framework.md](evaluation-framework.md) - metric definitions and paired-evidence requirements.
7. [trajectory-evaluation-design.md](trajectory-evaluation-design.md) - C0-C3 condition matrix, trajectory metrics, and delegation report.
8. [delegation-control-evaluation-summary.md](delegation-control-evaluation-summary.md) - current completed implementation, evidence, token/call boundary, and claim status.
9. [codex-usage-meter.md](codex-usage-meter.md) - what token and usage fields mean.

## Supporting Docs

- [architecture.md](architecture.md) - system structure.
- [claim-implementation-validation-20260527.md](claim-implementation-validation-20260527.md) - claim-to-implementation mapping.
- [codegraph-claim-comparison-20260527.md](codegraph-claim-comparison-20260527.md) - comparison against graph-memory/codegraph-style systems.
- [literature-grounded-evaluation-protocol.md](literature-grounded-evaluation-protocol.md) - task taxonomy and evaluation framing.
- [patent-paper-evaluation-expansion-20260527.md](patent-paper-evaluation-expansion-20260527.md) - expanded patent/paper evaluation plan.
- [re-evaluation-plan-20260527.md](re-evaluation-plan-20260527.md) - fresh-run re-evaluation plan.
- [review-frontier-correctness-20260527.md](review-frontier-correctness-20260527.md) - review-frontier correctness metrics.

## Removed From Current Docs

Older run-number result snapshots were removed from this source documentation set because they represented earlier protocols rather than the current measurement boundary.

Use current fresh-run snapshots and raw `.scopelease/experiments/` evidence when a numeric claim is needed. Do not promote earlier run-number averages as current evidence.

For CHI writing, treat [chi-paper-readiness.md](chi-paper-readiness.md) and [delegation-control-evaluation-summary.md](delegation-control-evaluation-summary.md) as the source-of-truth narrative. The `20260527` documents are supporting analysis only and should not be cited for current result numbers unless their archival status is explicitly stated.
