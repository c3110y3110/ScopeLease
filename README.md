# ScopeLease Decision Layer

ScopeLease is a repo-local delegation layer for coding agents. It turns a vague approval prompt such as "can the agent edit this repo?" into a graph-scoped contract: what the agent should read, which files and symbols are in scope, which commands are allowed, when it must stop, and which signed lease proves that the human approved that exact scope.

The product is intentionally narrow:

- build a CodeGraph-style repository graph from files, symbols, imports, tests, docs, routes, and policy hits
- reduce the initial context a coding agent such as Codex or Claude Code needs by emitting `readPlan`, `avoidPlan`, `agentContract`, and `graphQueryHints`
- show the impact graph, review frontier, and context-size delta locally
- keep approvals scoped with `scopelease_guard`, `scopelease_approve`, and signed approval leases
- enforce Bash/write actions before execution when a host uses ScopeLease `PreToolUse` hooks or `scopelease guarded-exec`
- keep every target project isolated through repo-local `.decision/`, `.codex/`, and `.scopelease/` state

The primary surface is CLI/MCP/hooks. The Electron build is an optional sidecar for inspecting graph evidence, approval state, and export/pair fixtures; it is not the main coding UI.

## ScopeLease Graph

ScopeLease uses a CodeGraph-style layer, but it is not just graph memory. The graph is the boundary for delegation:

```text
repo files/symbols/imports/tests/docs/routes/policies
  -> ScopeLease Graph
  -> read frontier + review frontier + permission frontier + stop frontier
  -> compact agent contract + graph-query hints
  -> guard decision + signed scope lease
```

The full graph stays local for inspection and evidence. The agent normally receives only compact graph-derived hints:

- `readPlan`: files and symbols the agent should inspect first
- `avoidPlan`: unrelated or risky areas the agent should not touch without a new reason
- `symbolFrontier`: symbol-level targets and dependencies for the request
- `reviewFrontier`: files likely to require human review
- `permissionFrontier`: allowed, ask-once, and denied action boundaries
- `stopFrontier`: conditions that invalidate the current delegation
- `agentContract`: the compact contract the agent is expected to follow
- `graphQueryHints`: graph-query-first hints so the agent can ask for more targeted context instead of reading the whole repo

This is why ScopeLease evidence separates visual/search-space graph claims from agent-visible token claims. `analysis.knowledgeGraph` is evidence and UI state; `contextPack.agentContext` and MCP payloads are the compact context actually shown to the agent.

## Quick Start

For this repo:

```bash
npm test
npm start
node src/cli.js attach .
node src/cli.js app . --open
npm run desktop       # optional sidecar
```

For another project:

```bash
node /path/to/scopelease/src/cli.js init /path/to/repo
node /path/to/scopelease/src/cli.js attach /path/to/repo
node /path/to/scopelease/src/cli.js app /path/to/repo --open
```

`attach` writes project-local Codex MCP and hook config under `/path/to/repo/.codex/`. `app` starts or reuses that repo's ScopeLease server on a stable repo-derived port. Different projects do not share baselines, policies, approval leases, or metering events. Claude Code-style usage can consume the same `.decision/codex-input.md` or `scopelease input` artifact, but ScopeLease does not call provider APIs by default.

When the target is a Git worktree, `init` and `attach` also add `.decision/`, `.codex/`, and `.scopelease/` to `.git/info/exclude` so local ScopeLease state is not accidentally committed.

## GitHub Source And App Use / GitHub 소스 공개와 앱 사용

For GitHub, publish the source tree and keep repo-local runtime state out of git.
GitHub에 올릴 때는 소스 트리만 올리고, 로컬 실행 상태는 git에 넣지 않습니다.

The root `.gitignore` excludes repo-local runtime state, MCP/hook attachment files, dependencies, packaged app output, logs, caches, env files, local benchmark data, temporary worktrees, and generated archives.
루트 `.gitignore`는 repo-local runtime state, MCP/hook attachment file, 의존성, 패키징 결과물, 로그, 캐시, 환경 파일, 로컬 benchmark data, 임시 worktree, 생성된 archive를 제외합니다.

Treat `scopelease_clean_source.zip` as a release or supplement artifact, not normal source.
`scopelease_clean_source.zip`은 일반 소스가 아니라 GitHub Release asset 또는 논문 supplement artifact로 따로 다룹니다.
Upload it only after regenerating and verifying it:
업로드 전에는 항상 다시 생성하고 검증합니다.

```bash
npm run paper:source-zip
npm run paper:verify:source-zip
npm run paper:verify:source-zip:test
```

The last command extracts `scopelease_clean_source.zip` into a temporary directory and runs `npm test`, `paper:verify:frozen`, and `paper:source-truth-check` from inside the extracted copy. It uses Node APIs instead of system `unzip`, so the check is suitable for macOS, Linux, and Windows npm environments.

A local source upload flow is:
로컬에서 GitHub에 올리는 기본 흐름은 다음과 같습니다.

```bash
git init
git add .
git commit -m "Prepare ScopeLease source release"
git branch -M main
git remote add origin git@github.com:<owner>/<repo>.git
git push -u origin main
```

With GitHub CLI:
GitHub CLI를 쓰는 경우:

```bash
gh repo create <owner>/<repo> --private --source=. --remote=origin --push
```

For local app use:
로컬 앱처럼 사용할 때:

```bash
npm install
npm run app         # browser sidecar
npm run desktop     # Electron sidecar
npm run package:mac # macOS arm64 app bundle under dist/
```

The default CLI, browser sidecar, desktop sidecar, tests, and source ZIP verifier use Node/npm scripts that run on macOS, Linux, WSL, and Windows native shells. Source ZIP creation and verification are implemented in Node, so they do not require system `zip` or `unzip`.
기본 CLI, 브라우저 sidecar, 데스크톱 sidecar, 테스트, source ZIP 검증은 macOS, Linux, WSL, Windows native shell에서 실행되는 Node/npm script로 구성되어 있습니다. Source ZIP 생성과 검증은 Node로 구현되어 있어 시스템 `zip` 또는 `unzip` 설치가 필요하지 않습니다.

`npm run package:mac` is intentionally macOS-only. Live Codex/Claude benchmark scripts still require the corresponding `codex` or `claude` CLI to be installed and authenticated on the machine running them.
`npm run package:mac`은 의도적으로 macOS 전용입니다. Live Codex/Claude benchmark script는 실행 머신에 해당 `codex` 또는 `claude` CLI가 설치되고 인증되어 있어야 합니다.

For another project, keep ScopeLease in this source tree and attach it to the target repo.
다른 프로젝트에서 쓸 때는 ScopeLease 소스는 이 트리에 두고, 대상 repo에 attach해서 사용합니다.

```bash
node /path/to/scopelease/src/cli.js init /path/to/repo
node /path/to/scopelease/src/cli.js attach /path/to/repo
node /path/to/scopelease/src/cli.js app /path/to/repo --open
```

Packaged macOS output still needs signing and notarization before broad external distribution.
패키징된 macOS 앱을 외부에 넓게 배포하려면 별도의 signing과 notarization이 필요합니다.

## Commands

```bash
scopelease init <repo>          # create .decision and baseline current files
scopelease index <repo>         # rebuild graph and reset baseline
scopelease analyze <repo>       # print the decision card
scopelease graph <repo>         # print compact terminal impact graph
scopelease live <repo>          # keep terminal KG refreshed
scopelease attach <repo>        # install repo-local Codex MCP/hooks
scopelease app <repo>           # ensure repo-local app/hooks on stable port
scopelease mcp <repo>           # expose MCP context/guard/metering tools
scopelease context <repo>       # print context pack JSON
scopelease input <repo>         # print agent prompt candidate + structured context
scopelease prompt <repo>        # print prompt text only
scopelease guard <repo>         # decide allow/ask/deny for an agent action
scopelease approve <repo>       # create a scoped signed approval lease after ask_once
scopelease enforce <repo>       # pre-execution PEP verdict for hooks/wrappers
scopelease guarded-exec <repo> -- npm test
scopelease card <repo>          # print decision card
scopelease checkpoint <repo>    # accept current tree as new baseline
```

Compatibility server aliases remain hidden for older scripts. Current Codex use should start with `attach` and `app`.

## Codex Setup

`scopelease attach <repo>` writes this project-local config:

```toml
[features]
hooks = true

[mcp_servers.scopelease]
command = "node"
args = ["/path/to/scopelease/src/cli.js", "mcp", "/path/to/repo"]
```

Prefer repo-local config over personal/global MCP config. Repo-local config makes the current Codex session point at the correct project path without relying on the agent to pass `repo` every time.

## MCP Flow

Agents should call `scopelease_get_context` before broad repository reads or edits. For patch application, call `scopelease_guard` first. If the verdict is `ask_once`, ask the user once, call `scopelease_approve` with `choiceId: "allow_scoped_patch"` after approval, then re-run `scopelease_guard` before applying.

When Codex hooks have recorded the current prompt, short follow-up calls such as "continue" or "응 해봐" inherit the active `pairId` and `runId`. A standalone request remains explicit, which prevents stale hook state from being reused for a new task.

When the host supports `PreToolUse`, ScopeLease installs a repo-local hook for Bash/apply_patch/Edit/Write. The hook calls `scopelease enforce` before the tool runs and exits non-zero on `ask_once` or `deny`, so in-scope signed leases continue without another prompt while out-of-scope actions are stopped before execution. For shell-only integrations, use `scopelease guarded-exec <repo> -- <command>` to run the same guard as a command wrapper.

Available MCP tools:

- `scopelease_get_context`: returns compact KG context and records exact ScopeLease-provided context tokens.
- `scopelease_guard`: evaluates an action against decision gates and approval leases.
- `scopelease_approve`: records a scoped approval lease after explicit approval.
- `scopelease_explain_delta`: explains paired default-codex versus scopelease-codex observed input deltas when both lanes are measured; only positive deltas are savings.
- `scopelease_measure`: records observed explore/edit/output payloads.
- `scopelease_detect_agent_usage`: detects agent-visible context signals from ScopeLease MCP, hooks/watchers, and Codex local aggregate state.
- `scopelease_record_usage`: optional separate provider usage ingest when a caller already has it; do not mix it into agent-visible savings.

## Local State

ScopeLease writes repo-local state only:

```text
<repo>/.decision/
  policies.yaml
  state.json
  latest-card.md
  context-pack.json
  codex-input.md
  context-ledger.json

<repo>/.codex/
  config.toml
  hooks.json
  hooks/scopelease-codex-hook.js
```

`.decision/` contains analysis state and artifacts. `.codex/` contains the project-local Codex integration. Both are intentionally scoped to one repo.

`state.json` stores hashes, graph metadata, compact evidence, and metering events. Baseline file bodies are not stored in the compact baseline index by default.

## Current Model

Input:

- repo path
- current files and symbols
- `.decision` baseline
- `.decision/policies.yaml`
- current user request

Output:

- changed files and symbols
- ScopeLease KG and compact impact graph
- read/avoid plan for a coding agent
- symbol-level frontier, review frontier, permission frontier, and stop frontier
- compact `agentContract` and `graphQueryHints` for graph-query-first work
- evidence paths for tests, docs, routes, imports, and policies
- decision gate and approval lease plan
- token, call, and precision/token metrics with explicit source boundaries

The context pack keeps these surfaces separate:

- `contextPack.codexInput.text`: prompt-shaped user input candidate for Codex or Claude Code-style agents
- `contextPack.agentContext`: compact structured context embedded in that prompt
- `analysis.knowledgeGraph`: visual ScopeLease KG stored for inspection, excluded from default Codex input

Token savings are only valid for the same work intent with two observed lanes:

```text
default-codex input n  = the payload actually given to Codex without ScopeLease
scopelease-codex input m    = ScopeLease MCP context plus any observed ScopeLease-lane tool/read payload
savings rate          = (n - m) / n
```

This is an agent-visible context metric for Codex/Claude Code-style systems. Full repository size is not a savings baseline, and provider/API billing usage is excluded from the default savings claim.

Reporting rule:

- Report `analysis.knowledgeGraph` as visual/search-space evidence, not as agent input.
- Report `latest_observed_pair_*` for live Codex/Claude-style claims. These rows use only actually observed hook/MCP payloads for the same work intent.
- Report command-level live averages with `product-wide-summary --claim-metric command-reported` when the evidence comes from Codex CLI `tokens used` or another agent command's reported total tokens.
- Report `latest_pair_delta_*` as a controlled prompt protocol result, together with `latest_pair_baseline_modes` and `latest_pair_scopelease_modes`.
- Do not describe controlled full-file or `readPlanFiles` protocols as actual Codex default behavior. Codex usually retrieves, summarizes, and tools its way through context rather than receiving whole files up front.

Current bounded evidence lives in `docs/current-product.md`, `docs/current-research-memory.md`, and `docs/delegation-control-evaluation-summary.md`. Claim-ready command-reported token results now include the frozen 13-repository, 102-pair protocol and the 2026-06-08 resource-bounded Codex/Claude C0/C3 local-main protocols. These remain command-reported protocol results, not provider billing, hidden reasoning, agent-visible savings, broad four-condition C0-C3 evidence, or human fatigue evidence.

After changing ScopeLease source code, restart or reattach any already-running MCP server before treating MCP guard output as final. The active hook/CLI path uses the current code, while an older MCP process can retain a stale action-policy snapshot.

## More Detail

See [docs/README.md](docs/README.md) first, then [docs/current-research-memory.md](docs/current-research-memory.md), [docs/current-product.md](docs/current-product.md), [docs/architecture.md](docs/architecture.md), and [docs/codex-usage-meter.md](docs/codex-usage-meter.md).
