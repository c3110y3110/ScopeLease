# ScopeLease x Claude Code Experiment Record

Updated: 2026-06-08 KST.

This document separates three facts that were previously mixed together:

1. Claude Code support is implemented in the harness.
2. The shell `PATH` check can be empty, but the harness resolves the local Claude install path directly.
3. The current 2026-06-07 Claude live pilot produces bounded pilot measurement pairs, not formal average evidence.
4. A historical Claude pilot artifact remains available as older supporting evidence.
5. The 2026-06-08 resource-bounded Claude formal local main is complete as a C0/C3 command-reported protocol.

## Implemented Claude Support

ScopeLease has Claude-specific wiring:

| File | Current support |
| --- | --- |
| `src/core/pair-harness.js` | `claude` preset, local executable resolution from `SCOPELEASE_CLAUDE_BIN` or common install paths, `--output-format json`, usage parsing via `claude_cli_json_usage`, C3 template with `--mcp-config`, `--allowedTools`, and `--append-system-prompt` |
| `src/runtime/app-service.js` | `attachScopeLeaseClaudeProject`, project `.mcp.json`, and `.claude/settings.json` hook generation |
| `src/cli.js` | `attach --agent claude` |
| `package.json` | Claude live-pilot and formal dry-run scripts |

The intended C0/C3 contrast is:

```text
C0: claude -p --output-format json < prompt.md
C3: claude -p --output-format json --mcp-config ... --allowedTools ... --append-system-prompt ... < prompt.md
```

Command-reported token boundary:

```text
Claude JSON usage input + output + cache_creation + cache_read
```

This is not provider billing and does not include unreported hidden reasoning.

## Current 2026-06-07 Run

Commands checked:

```bash
command -v claude
claude --version
npm run paper:live-pilot:claude:dry-run
npm run paper:live-pilot:claude
```

Current results:

| Check | Result |
| --- | --- |
| `command -v claude` | empty |
| `claude --version` | exit 127 from shell `PATH`; diagnostic only |
| harness executable resolution | resolved local install candidate, including `$HOME/.local/bin/claude` |
| Claude live-pilot dry-run | pass; 1 repo, 4 expected pairs |
| Claude resource-bounded formal dry-run | pass; 11 repos, 176 expected pairs |
| Claude live-pilot execution | passed |
| Claude resource-bounded formal execution | passed; 11 repos, 176 measured pairs |
| lane commands | 8/8 passed |
| measured command-reported pairs | 4 |
| product summary status | `pilot_ready_not_formal_claim`; below the 10-repository/100-pair formal floor |

Current claim: Claude command construction, local executable resolution, command execution, and `claude_cli_json_usage` parsing are verified for both the 1-repo/4-pair pilot and the 11-repository/176-pair resource-bounded formal local main.

Optional explicit override:

```bash
SCOPELEASE_CLAUDE_BIN="/absolute/path/to/claude" npm run paper:live-pilot:claude
```

Current source of truth:

```text
.scopelease/experiments/pilot-claude-main-20260607/product-wide-summary.json
.scopelease/reports/pilot-claude-main-20260607/claim-ready-report.json
.scopelease/experiments/formal-local-main-claude-resource-bounded/product-wide-summary.json
.scopelease/reports/formal-local-main-claude-resource-bounded/claim-ready-report.json
```

Current measurement:

| Metric | Current result |
| --- | ---: |
| repositories | 1 |
| same-workIntent pairs | 4 |
| lane commands | 8/8 passed |
| lane timeouts | 0 |
| run duration | 1,064,526 ms |
| command-reported source | `claude_cli_json_usage` |
| command-reported tokens | 2,304,719 -> 1,674,373 |
| weighted token delta | 27% lower |
| macro token delta | 22% lower |
| median token delta | 37.5% lower |
| positive / overhead pairs | 3 / 1 |
| decision-prompt proxy | 456 -> 4, 99% lower |
| command duration proxy | 632,181 ms -> 426,178 ms, 33% lower |
| heuristic command-quality pairs | 4/4; score 100% |
| task-specific completion rubric | not configured |

Per task:

| Task | C0 tokens | C3 tokens | Delta |
| --- | ---: | ---: | ---: |
| architecture_review | 474,544 | 292,524 | 38% lower |
| test_validation | 1,145,126 | 722,869 | 37% lower |
| permission_workflow | 351,970 | 583,957 | 66% overhead |
| ambiguous_requirement | 333,079 | 75,023 | 77% lower |

## Historical Claude Pilot

Artifact:

```text
.scopelease/experiments/claude-pilot5/
.scopelease/experiments/claude-pilot5-scopelease_paper/
```

Historical result summary:

| Metric | Historical result |
| --- | ---: |
| repositories | 1 |
| same-workIntent pairs | 4 |
| command-reported source | `claude_cli_json_usage` |
| command-reported tokens | 2,065,761 -> 1,456,429 |
| weighted token delta | 29% lower |
| macro token delta | 32% lower |
| positive / overhead pairs | 4 / 0 |
| task-specific completion rubric | not configured |

Per task:

| Task | C0 tokens | C3 tokens | Delta |
| --- | ---: | ---: | ---: |
| architecture-frontier | 534,843 | 313,480 | 41% lower |
| test-boundary | 725,579 | 607,296 | 16% lower |
| permission-command | 474,530 | 361,895 | 24% lower |
| ambiguous-escalation | 330,809 | 173,758 | 47% lower |

Use this only as a labeled historical Claude pilot. It is still below the formal 10-repository/100-pair floor and lacks task-specific quality rubrics.

## Current Codex Comparison

The current same-task Codex pilot did run successfully on 2026-06-07:

| Agent/run | Status | Pairs | Command-reported tokens | Weighted delta |
| --- | --- | ---: | ---: | ---: |
| Codex `pilot-codex-main-20260607` | measured | 4 | 370,894 -> 281,438 | 24% lower |
| Claude `pilot-claude-main-20260607` | measured | 4 | 2,304,719 -> 1,674,373 | 27% lower |
| Claude `claude-pilot5` | historical measured | 4 | 2,065,761 -> 1,456,429 | 29% lower |

Resource-bounded formal local main comparison:

| Agent/run | Status | Repos | Pairs | Command-reported tokens | Weighted / macro / median |
| --- | --- | ---: | ---: | ---: | ---: |
| Codex `formal-local-main-codex-resource-bounded` | measured | 11 | 176 | 11,830,597 -> 3,879,686 | 67% / 59% / 71% lower |
| Claude `formal-local-main-claude-resource-bounded` | measured | 11 | 176 | 49,656,538 -> 21,824,362 | 56% / 38% / 52.5% lower |

Do not mix Codex and Claude into one aggregate. The valid statement is that both current 2026-06-07 lean pilots completed on the same 1-repository/4-pair task set, each with its own command-reported source and pilot boundary.

## Claim Boundary

Allowed:

- ScopeLease has implemented Claude command construction and MCP/hook attachment support.
- Claude dry-run manifests can be constructed for the same pilot and formal local-main task sets.
- The current Claude pilot verifies local binary auto-detection, 8/8 successful lane commands, and four measured same-workIntent command-reported pairs.
- The current Claude pilot showed `2,304,719 -> 1,674,373` `claude_cli_json_usage` command-reported tokens, a `27%` weighted lower delta, with `3` positive pairs and `1` overhead pair.
- The current resource-bounded Claude formal local main completed `176` same-workIntent C0/C3 command-reported pairs over `11` repositories and showed `49,656,538 -> 21,824,362` `claude_cli_json_usage` command-reported tokens, a `56%` weighted lower delta, with `156` positive pairs and `20` overhead pairs.
- The historical `claude-pilot5` artifact showed a bounded one-repository, four-pair command-reported reduction.

Not allowed:

- provider/API billing reduction;
- task-quality improvement from the Claude pilot;
- broad four-condition C0-C3 generalization across Claude tasks or repositories.
# Claude CLI Evidence Addendum (2026-06-08)

Current Claude-specific boundary:

- The Claude CLI one-repository live pilot is complete and can be reported as
  bounded feasibility evidence.
- The pilot uses Claude CLI JSON usage as command-reported usage evidence.
- The resource-bounded Claude formal local main is complete: 11 repositories and
  176 same-workIntent C0/C3 command-reported pairs.
- The dry-run and non-dry-run protocol reports `repoTimeoutMs: 0` and
  `commandTimeoutMs: 0`; it does not rely on an artificial 300,000 ms timeout.
- The Claude formal main outcome is claimable only as command-reported protocol
  evidence, not provider billing or human outcome evidence.

Use this boundary when comparing Codex and Claude: both agents currently have
completed one-repository pilots and completed resource-bounded C0/C3 main
protocols. Keep the agents separate rather than mixing them into one aggregate.
