# Architecture

ScopeLease is split into local analysis, runtime attachment, MCP tooling, and visual inspection. The important boundary is that all decisions and metering are scoped to one repository path.

```text
src/
  cli.js                    command entrypoint
  analyzer.js               stable public exports
  server.js                 compatibility export for runtime/http-server.js
  constants.js              shared defaults and risk constants
  fs-utils.js               filesystem helpers
  policy.js                 policy loading and matching
  symbols.js                symbol/import extraction

  core/
    repository.js           index -> diff -> policy -> graph -> artifacts
    indexer.js              file, symbol, import, test, doc graph
    change-set.js           current tree vs baseline
    impact.js               ScopeLease KG and compact impact graph
    assessment.js           risk, uncertainty, and routing
    action-policy.js        agent action normalization and grant mapping
    approval-lease.js       scoped approval reuse
    guard.js                decision gate evaluation
    artifacts.js            context pack, agent input candidate, decision card
    events.js               timeline event signatures and dedupe

  runtime/
    http-server.js          repo-local app server, SSE, REST APIs, static surface
    app-service.js          attach/app setup, project-local hooks, stable repo ports
    mcp-server.js           ScopeLease MCP tools over stdio
    usage-proxy.js          optional provider usage proxy
    watch-service.js        long-running watcher + periodic scan

  terminal/
    graph-renderer.js       compact KG map, list graph, DOT output
    live.js                 terminal live mode

public/
  graph.html                focused ScopeLease KG surface
  graph-view.js             visual KG, token delta, approval state
  index.html                compact status shell
```

## Current Data Flow

```text
scopelease attach <repo>
  -> write <repo>/.codex/config.toml
  -> write <repo>/.codex/hooks.json
  -> configure MCP args ["mcp", "<repo>"]

scopelease app <repo>
  -> resolve stable repo port
  -> ensure attach output exists
  -> start runtime/http-server.js with repo-local app and optional proxy endpoints
  -> lock runtime to that repo path

Codex session in <repo>
  -> scopelease_get_context
  -> scopelease_guard
  -> optional scopelease_approve
  -> scopelease_guard again
  -> apply/test/report
```

## Analysis Flow

```text
analyzeRepository()
  -> buildIndex()
  -> detectChanges()
  -> matchPolicies()
  -> findRelated()
  -> buildImpactGraph()
  -> buildKnowledgeGraph()
  -> buildContextPack()
  -> buildDecisionCardMarkdown()
```

## Persistence

ScopeLease stores project-local state in the analyzed repository:

```text
.decision/
  policies.yaml
  state.json
  latest-card.md
  context-pack.json
  codex-input.md
  context-ledger.json

.codex/
  config.toml
  hooks.json
  hooks/scopelease-codex-hook.js
```

The app server can be global in the sense that it is long-running, but its effects are local: every runtime is locked to one repo path and writes to that repo's `.decision/`.

## Graph Surfaces

ScopeLease keeps two graph surfaces separate:

- `analysis.knowledgeGraph`: visual ScopeLease KG for inspection. Nodes expose `labels` and `properties`; relationships expose `relationshipType` and `properties`.
- `analysis.graph`: compact impact graph for terminal rendering and evidence paths.

The default agent input does not include full graph JSON. It uses `contextPack.codexInput.text`, which wraps compact `contextPack.agentContext` in a prompt-shaped user message. The field name is still `codexInput` for compatibility, but the content is a local prompt candidate that can also be reused by Claude Code-style workflows.
