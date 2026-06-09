# Security Policy

ScopeLease runs repo-local hooks, MCP tools, and optional command wrappers. Security reports should focus on cases where ScopeLease allows, hides, or misclassifies actions that should be blocked or explicitly approved.

ScopeLease는 repo-local hook, MCP tool, optional command wrapper를 실행합니다. 보안 신고는 차단되거나 명시 승인되어야 할 action을 ScopeLease가 허용, 은폐, 오분류하는 경우에 집중해 주세요.

## Supported Versions

There is not yet a stable public release series. Treat `main` as the current source-release branch until a release policy is added.

아직 안정 public release series는 없습니다. release policy가 추가되기 전까지 `main`을 current source-release branch로 봅니다.

## Reporting A Vulnerability

Preferred path:

1. Use GitHub private vulnerability reporting if it is enabled for the repository.
2. If private reporting is not enabled, contact the repository owner directly before posting technical exploit details publicly.
3. Do not include API keys, private source code, access tokens, unredacted logs, or private repository paths in a public issue.

선호 경로:

1. GitHub private vulnerability reporting이 켜져 있으면 그 기능을 사용합니다.
2. private reporting이 꺼져 있으면 technical exploit detail을 public issue에 올리기 전에 repository owner에게 직접 연락합니다.
3. public issue에는 API key, private source code, access token, 원본 log, private repository path를 넣지 않습니다.

## In Scope

- Bypass of `scopelease_guard`, `scopelease enforce`, or `scopelease guarded-exec`.
- Approval lease reuse outside the original request, baseline, path, command, or expiry boundary.
- Hook behavior that silently allows denied Bash/write/checkpoint/network/external-write actions.
- Path traversal in repo-local file reads or sidecar file endpoints.
- Leaks of ignored local state such as `.decision/`, `.codex/`, `.scopelease/`, `.claude/`, `.mcp.json`, or provider usage data.

## Out Of Scope

- Provider billing disputes.
- Hidden model reasoning behavior that ScopeLease cannot observe.
- Unsafe behavior when ScopeLease hooks or wrappers are not connected.
- Issues caused by intentionally running untrusted commands outside `guarded-exec` or connected agent hooks.

## Security Notes

- The model proxy is disabled by default.
- Provider usage ingestion is separate from agent-visible context metering.
- ScopeLease is not a universal sandbox.
- Restart or reattach MCP servers after source changes so guard policy snapshots are current.
