# Contributing To ScopeLease

ScopeLease is currently a source-release and research-oriented repository. Contributions should stay aligned with the product boundary: repo-local graph-scoped delegation for coding agents.

ScopeLease는 현재 source release와 research-oriented repository입니다. contribution은 repo-local graph-scoped delegation이라는 제품 경계에 맞아야 합니다.

## Before Contributing

- Check whether a `LICENSE` file has been added. Until then, do not assume broad reuse or redistribution terms.
- Keep local runtime state out of commits: `.decision/`, `.codex/`, `.scopelease/`, `.claude/`, `.mcp.json`, `node_modules/`, `dist/`, and generated archives.
- Do not include secrets, API keys, private repository paths, provider logs, or unredacted user data.
- Do not expand claims beyond the evidence boundaries in `README.md` and `docs/current-product.md`.

## Development Setup

```bash
git clone https://github.com/c3110y3110/ScopeLease.git
cd ScopeLease
npm install
npm test
```

Useful checks:

```bash
npm test
npm run desktop:check
npm run analyze
npm run graph
```

## Documentation Rules

- Put first-run instructions in `README.md`.
- Put current product boundaries in `docs/current-product.md`.
- Put open-source packaging readiness in `docs/open-source-product-readiness.md`.
- Put research and claim-boundary material under `docs/`.
- Keep screenshots under `docs/assets/`.
- Mark archival or dated protocol notes clearly.

## Evidence Rules

ScopeLease evidence must keep source boundaries separate:

- agent-visible context is not provider billing.
- command-reported tokens are not hidden reasoning tokens.
- full repository size is search-space evidence, not a savings baseline.
- graph-bench results are retrieval diagnostics unless paired with same-work-intent agent runs.

## Pull Request Expectations

Before asking for review:

- Explain the product surface touched: core, connector, sidecar, evaluation, docs, or release packaging.
- Include the commands you ran.
- Include screenshots for sidecar UI changes.
- Keep unrelated refactors out of the patch.
- Do not run `checkpoint` as part of a contribution unless maintainers ask for it.

## Korean Short Version

기여 전에는 license가 정해졌는지 확인해야 합니다. local runtime state와 secret은 commit하지 말고, claim은 README와 `docs/current-product.md`의 evidence boundary를 넘기면 안 됩니다. PR에는 변경한 제품 surface와 실행한 검증 명령을 적어야 합니다.
