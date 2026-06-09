# Open-Source Product Readiness

This document separates what is already ready for a source release from what still needs an owner decision before ScopeLease should be presented as a mature open-source product.

이 문서는 ScopeLease가 source release로 이미 준비된 부분과, 성숙한 오픈소스 제품으로 보이기 전에 owner 결정이 필요한 부분을 분리합니다.

## Current Product Shape

ScopeLease is best described as a repo-local delegation-control product family for coding agents.

ScopeLease는 coding agent를 위한 repo-local delegation-control 제품군으로 설명하는 것이 가장 정확합니다.

| Layer | User-facing surface | Role |
| --- | --- | --- |
| Core decision layer | `scopelease analyze`, `scopelease context`, `scopelease input` | Build repo graph, task frontiers, decision cards, and compact agent context. |
| Permission layer | `scopelease guard`, `scopelease approve`, `scopelease enforce`, `scopelease guarded-exec` | Evaluate action scope and reuse signed approval leases. |
| Agent connectors | Codex MCP/hooks, Claude MCP/hooks | Bind ScopeLease decisions to agent tool execution. |
| Sidecars | Browser app, KG view, Electron app, hub | Make delegation boundaries and evidence inspectable. |
| Evaluation layer | Review bench, graph bench, permission fixtures, C0-C3 pair harness | Produce bounded evidence without overstating claims. |
| Release/evidence package | Source zip verifier, frozen evidence, docs, patent package | Preserve reproducible source and claim boundaries. |

## ScopeLease vs CodeGraph-Style Tools

ScopeLease should not be marketed as a generic CodeGraph replacement. It uses graph structure to decide delegation boundaries.

ScopeLease는 범용 CodeGraph 대체재로 홍보하면 안 됩니다. graph structure를 사용하지만 목적은 delegation boundary 결정입니다.

Safe positioning:

- ScopeLease can consume repo-local KG or CodeGraph-like payloads.
- ScopeLease reduces those graph signals into read, review, permission, and stop frontiers.
- ScopeLease binds frontiers to signed approval leases.
- ScopeLease measures agent-visible context and command-reported token/call evidence only under named boundaries.

Unsafe positioning:

- "ScopeLease is better than all CodeGraph tools."
- "ScopeLease always reduces Codex or Claude token usage."
- "ScopeLease reduces provider billing."
- "ScopeLease reduces hidden reasoning tokens."
- "ScopeLease is a universal sandbox outside connected hooks or wrappers."

한국어 기준으로는 이렇게 표현하면 됩니다. ScopeLease는 graph memory 자체가 아니라, graph를 agent delegation boundary로 바꾸는 제품입니다.

## Ready Now

- `README.md` explains clone, install, test, app, Codex attach, Claude attach, evidence boundaries, and GitHub source hygiene.
- Browser sidecar screenshots exist in `docs/assets/`.
- `npm test` covers the current implementation.
- `npm run desktop:check` verifies desktop/runtime entry-point syntax.
- `.gitignore` excludes local ScopeLease/Codex/Claude state, dependencies, archives, reports, caches, and secrets.
- Source zip generation and verification are implemented.
- Bounded evidence is separated from provider billing and hidden-token claims.
- Starter `CONTRIBUTING.md`, `SECURITY.md`, and `CHANGELOG.md` now exist.

## Owner Decisions Still Needed

These items should be resolved before inviting outside contributors or presenting the repository as a fully open-source project.

외부 contributor를 받거나 완전한 오픈소스 프로젝트로 소개하기 전에는 아래 결정을 먼저 해야 합니다.

| Item | Why it matters | Suggested action |
| --- | --- | --- |
| License | A public repository without an explicit license does not clearly grant reuse rights. | Choose a license such as MIT, Apache-2.0, or another owner-approved license, then add `LICENSE`. |
| Contribution terms | External patches need legal and review expectations. | Keep `CONTRIBUTING.md`, then update it after the license decision. |
| Security contact | Guard/MCP/hook behavior can affect local command execution. | Enable GitHub private vulnerability reporting or publish a dedicated contact path. |
| CI | Users expect every push and PR to run tests. | Add `.github/workflows/ci.yml` after deciding the CI matrix. |
| Release policy | Users need stable install points. | Add tags and GitHub Releases when the release cadence is chosen. |
| Package distribution | `package.json` is currently `private: true`. | Decide whether ScopeLease remains source-only or becomes an npm package. |
| Desktop distribution | Electron packaging currently targets local macOS builds. | Add signing/notarization only when broad desktop distribution is planned. |
| Public support | Users need to know whether issues are accepted. | Add issue templates and support labels when support scope is known. |

## Recommended Next Pulls

1. Add a license after owner/legal review.
2. Add GitHub Actions CI:

   ```yaml
   name: CI
   on:
     push:
       branches: [main]
     pull_request:
       branches: [main]
   jobs:
     test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with:
             node-version: 20
             cache: npm
         - run: npm ci
         - run: npm test
         - run: npm run desktop:check
   ```

3. Add issue and pull request templates after support scope is known.
4. Decide whether `private: true` should remain in `package.json`.
5. Add a release checklist for source zip, frozen evidence verification, and GitHub Release assets.

## Documentation Structure To Keep

Use this split when adding new docs:

- `README.md`: first-run product explanation and commands.
- `docs/current-product.md`: current implementation boundary and safe claims.
- `docs/open-source-product-readiness.md`: OSS packaging and release readiness.
- `docs/current-research-memory.md`: patent/CHI framing and evidence rules.
- `docs/delegation-control-evaluation-summary.md`: current evaluation narrative.
- `examples/evaluation/frozen-evidence/*`: frozen evidence packages.
- `patent-package/*`: patent handoff material.

Do not promote dated protocol snapshots to current headline claims unless the archival status is explicit.

날짜가 붙은 과거 protocol snapshot은 archival status를 명시하지 않고 현재 headline claim으로 올리면 안 됩니다.

## Release Checklist

Before a public release:

- Run `npm test`.
- Run `npm run desktop:check`.
- Run `npm run paper:verify:frozen`.
- Run `npm run paper:source-truth-check`.
- Run `npm run paper:source-zip`.
- Run `npm run paper:verify:source-zip`.
- Run `npm run paper:verify:source-zip:test`.
- Confirm `git status --short --ignored` shows only intended local ignored state.
- Confirm no `.decision/`, `.codex/`, `.scopelease/`, `.claude/`, `.mcp.json`, `node_modules/`, `dist/`, or generated archives are committed unless intentionally part of a release asset.

## Korean Short Version

ScopeLease는 이제 source release로는 충분히 정리되어 있습니다. 하지만 CodeGraph 같은 성숙한 오픈소스 제품군으로 보이려면 license, CI, issue/PR template, release policy, npm publish 여부, security contact를 결정해야 합니다. README에는 제품군과 CodeGraph 차이를 넣었고, 이 문서는 남은 운영 결정을 추적합니다.
