# 03. 구현 매핑

이 문서는 특허 구성요소가 현재 코드 어디에 구현되어 있는지 연결한다. 변리사가 실시예를 확인할 때 쓰는 근거표다.

## 전체 구조

| 특허 구성 | 쉬운 설명 | 구현 위치 |
| --- | --- | --- |
| 저장소 분석 | 파일, 심볼, import, 테스트, 문서, 정책 관계를 만든다 | `src/analyzer.js`, `src/core/repository.js` |
| operational graph adapter | 내부 KG 또는 외부 CodeGraph류 payload를 공통 graph node/edge 형태로 정규화한다 | `src/core/graph-adapter.js` |
| frontier 생성 | context, review, permission, stop 경계를 graph node 집합으로 만든다 | `src/core/frontier.js` |
| context pack | readPlan, avoidPlan, traceLedger, agent input을 만든다 | `src/core/artifacts.js`, `src/core/adaptive-context.js` |
| action 정규화 | 에이전트 작업을 read/edit/bash/checkpoint 등으로 정리한다 | `src/core/action-policy.js` |
| guard 판단 | 허용, 승인 필요, 거부를 판단한다 | `src/core/guard.js` |
| approval lease | 승인 범위 객체를 만들고 검증한다 | `src/core/approval-lease.js` |
| MCP 도구 | Codex/Claude 계열 agent가 context, guard, approve를 호출한다 | `src/runtime/mcp-server.js` |
| hooks/sidecar | Codex 프로젝트에 MCP와 hook을 연결한다 | `src/runtime/app-service.js` |
| paired metering | default lane과 ScopeLease lane을 나눠 실험한다 | `src/core/pair-harness.js` |
| claim report | 특허/평가용 claim boundary 문서를 만든다 | `src/core/study-report.js` |
| formal evaluation | 10개 이상 저장소, 100개 이상 pair 실행 자동화 | `scripts/run-formal-command-eval.mjs` |

## 핵심 함수 매핑

| 기능 | 함수 또는 단위 | 파일 |
| --- | --- | --- |
| 에이전트 action 정규화 | `normalizeAgentAction` | `src/core/action-policy.js` |
| action grant 분류 | `actionGrant` | `src/core/action-policy.js` |
| hard deny 판정 | `isHardDenyAction` | `src/core/action-policy.js` |
| shell control 감지 | `hasUnsafeShellControl` | `src/core/action-policy.js` |
| 안전한 로컬 read 명령 판정 | `isSafeLocalReadCommand` | `src/core/action-policy.js` |
| 안전 테스트 명령 판정 | `isSafeTestCommand` | `src/core/action-policy.js` |
| path escape 감지 | `hasUnsafeCommandPathEscape` | `src/core/action-policy.js` |
| approval lease 생성 | `createApprovalLease` | `src/core/approval-lease.js` |
| approval lease 검증 | `validateLease` | `src/core/approval-lease.js` |
| 유효 lease 탐색 | `findValidLease` | `src/core/approval-lease.js` |
| command scope 검증 | `commandWithinScope` | `src/core/approval-lease.js` |
| HMAC payload 생성 | `hmacLeasePayload` | `src/core/approval-lease.js` |
| operational graph 생성 | `buildOperationalGraph` | `src/core/graph-adapter.js` |
| 외부 graph payload 정규화 | `normalizeGraphBackendPayload` | `src/core/graph-adapter.js` |
| graph scope hash 생성 | `graphScopeHash` | `src/core/graph-adapter.js` |
| context/review/permission/stop frontier 생성 | `buildFrontiers` | `src/core/frontier.js` |
| lease용 frontier 압축 | `compactFrontierForLease` | `src/core/frontier.js` |
| context pack 생성 | `buildContextPack` | `src/core/artifacts.js` |
| decision card 생성 | `buildDecisionCardMarkdown` | `src/core/artifacts.js` |
| agent input 생성 | `buildAgentInputPayload` | `src/core/artifacts.js` |
| paired 실험 실행 | `runAgentPairHarness` | `src/core/pair-harness.js` |
| scoped workspace 구성 | `copyScopedWorkspace` | `src/core/pair-harness.js` |
| command token 파싱 | `parseCommandReportedTotalTokens` | `src/core/pair-harness.js` |
| pair delta 요약 | `summarizeCommandReportedPairDeltas` | `src/core/pair-harness.js` |
| claim report 작성 | `buildClaimReadyReport` | `src/core/study-report.js` |
| human study protocol 작성 | `exportHumanDecisionStudyProtocol` | `src/core/study-report.js` |

## MCP 도구 매핑

| MCP 도구 | 역할 | 구현 위치 |
| --- | --- | --- |
| `scopelease_get_context` | 사용자 요청에 맞는 context pack 제공 | `toolGetContext` in `src/runtime/mcp-server.js` |
| `scopelease_guard` | 에이전트 action을 허용, 승인 필요, 거부로 판정 | `toolGuard` in `src/runtime/mcp-server.js` |
| `scopelease_approve` | 승인 필요 action에 대해 approval lease 발급 | `toolApprove` in `src/runtime/mcp-server.js` |
| `scopelease_explain_delta` | 같은 요청의 context/token delta 설명 | `toolExplainDelta` in `src/runtime/mcp-server.js` |
| `scopelease_measure` | default/scopelease lane의 관측 입력 기록 | `toolMeasure` in `src/runtime/mcp-server.js` |

## approval lease 구현 설명

`src/core/approval-lease.js`는 특허의 가장 중요한 실시예다.

구현된 lease는 다음 필드를 포함한다.

```text
id
decisionBundleId
choiceId
createdAt / expiresAt
requestHash
baselineHash
riskMax
allowedActions
blockedActions
fileScopes
pathAllow / pathDeny
commandScopes
baselineGraphHash
graphScopeHash
reviewFrontierHash
permissionFrontierHash
allowedGraphNodes
reviewGraphNodes
stopGraphNodes
graphBackend
maxFiles
approvedChangedFiles
stopWhen
signatureVersion
signatureAlgorithm = hmac-sha256
signatureKeyId
signature
```

검증은 다음 순서로 이해하면 된다.

1. action을 정규화한다.
2. lease 서명을 검증한다.
3. 만료 시간, request hash, baseline hash, graph hash가 맞는지 본다.
4. hard deny action인지 본다.
5. action grant가 lease 허용 범위 안인지 본다.
6. 파일 경로가 file scope, allow/deny 범위 안인지 본다.
7. action node와 file node가 approval graph scope 안에 있는지 본다.
8. bash 명령이면 command scope를 검증한다.
9. `apply_patch`는 승인된 변경 파일 범위 밖이면 lease를 무효화한다. `run_tests`는 기존 변경 파일 때문에 무효화하지 않는다.
10. shell control operator는 quote-aware로 판정하며, read-only pipeline은 제한적으로 허용하고 redirect, `&&`, `;`, 위험 명령, `/tmp` escape는 차단한다.
11. stop condition이 발생했는지 본다.

## operational graph와 frontier 구현 설명

`src/core/graph-adapter.js`는 ScopeLease 내부 KG를 공통 operational graph로 바꾼다. 이 계층은 CodeGraph, Codebase-Memory, CPG 같은 외부 code graph backend 결과가 들어와도 파일 노드, 심볼 노드, 정책 노드, action 노드로 정규화할 수 있게 만든다. 현재 구현은 외부 서버 프로세스를 직접 실행하지는 않지만, 실행 경로는 열려 있다. CLI는 `--graph-backend-file`과 `--graph-backend`로 graph-shaped JSON payload를 받고, MCP는 `graphBackendPayload`와 `graphBackendName` 인자를 받는다. 이렇게 주입된 외부 graph는 같은 frontier 계산, `graphScopeHash`, `baselineGraphHash`, approval lease 생성 및 검증에 사용된다. `graphScopeHash`에는 backend label이 들어가고, `baselineGraphHash`에는 외부 payload hash가 들어가므로, 승인 당시 graph backend 또는 payload가 바뀌면 기존 lease는 같은 경계로 보지 않는다.

`src/core/frontier.js`는 하나의 graph에서 파일 경계와 심볼 경계를 분리해 계산한다.

| frontier | 의미 | 특허상 효과 |
| --- | --- | --- |
| context frontier | agent 입력 후보로 보낼 최소 근거 | 전체 KG를 prompt에 넣지 않음 |
| symbol frontier | 변경 심볼과 targeted probe 심볼의 노드/해시/위치 | 파일 전체 탐색 전에 심볼 단위 frontier를 사용 |
| review frontier | 사람이 검토할 파일/심볼/정책 근거 | 전체 diff review를 줄이는 근거 |
| permission frontier | lease로 위임 가능한 action/file node 범위 | 승인 범위를 graph hash로 고정 |
| stop frontier | network, external write, checkpoint 같은 중단 node | 범위 이탈 시 ask/deny 근거 |

approval lease는 이제 파일 범위만 저장하지 않고 `baselineGraphHash`, `graphScopeHash`, `permissionFrontierHash`, `allowedGraphNodes`를 포함한다. compact agent contract는 여기에 `symbolFrontierHash`, 허용 action, stop 조건, graph-query-first 순서를 요약한다. 따라서 "이 파일을 수정해도 되는가"뿐 아니라 "이 action이 승인 당시 graph scope 안에 있는가"까지 검증한다.

## context 생성 구현 설명

`src/core/artifacts.js`와 `src/core/adaptive-context.js`는 agent에게 줄 입력을 만든다.

중요한 점은 화면용 전체 그래프와 agent 입력용 compact context를 분리한다는 것이다. 화면에는 큰 KG를 보여줄 수 있지만, agent 입력에는 우선순위가 높은 근거만 넣는다.
agent 입력에는 `agentContract`와 `graphQueryHints`가 포함된다. 이는 전체 그래프 payload가 아니라, 어떤 frontier/readPlan/symbolProbe를 먼저 확인하고 언제 guard를 다시 호출할지 알려주는 작은 실행 계약이다.

명세서에서는 다음 표현이 안전하다.

> 저장소 전체 파일 본문이나 전체 시각화 그래프를 agent 입력으로 제공하는 것이 아니라, 변경 집합과 지식그래프 관계에 따라 산출된 readPlan, symbolFrontier, agentContract, graphQueryHints, avoidPlan 및 traceLedger를 agent-visible compact context로 제공한다.

## paired metering 구현 설명

`src/core/pair-harness.js`는 같은 작업을 `default-codex` lane과 `scopelease-codex` lane으로 나눈다.

핵심 구현은 다음과 같다.

- 같은 `workIntent`와 `pairId`를 부여한다.
- default lane은 자연 요청 또는 지정 baseline으로 실행한다.
- ScopeLease lane은 readPlan-scoped workspace로 실행할 수 있다.
- Codex CLI가 보고한 `tokens used`를 command-reported token으로 저장한다.
- delta가 양수이면 savings, 음수이면 overhead로 보존한다.
- provider billing과 command-reported token을 섞지 않는다.

## 현재 구현의 한계

현재 구현은 강제 보안 제품이라고 쓰면 안 된다.

현재 가능한 표현은 다음이다.

> ScopeLease는 MCP guard와 HMAC-signed approval lease를 통해 에이전트 action을 사전 판정하고 후속 action을 재검증한다.

아직 피해야 할 표현은 다음이다.

> ScopeLease는 모든 host와 모든 에이전트 tool 실행을 무조건 실행 전에 물리적으로 차단한다.

현재 구현은 Codex-style `PreToolUse` hook과 `guarded-exec` command wrapper가 ScopeLease를 호출하는 경우에 실행 전 차단한다. 따라서 특허 문구는 "연결된 집행 지점을 통해 실행 전 검증한다"로 한정해야 한다.

현재 hook regression에서 확인된 경계는 다음이다.

- ScopeLease 내부 control command와 sidecar startup은 자기 자신의 승인 경로를 막지 않는다.
- `apply_patch` path 추출은 실제 수정 파일을 기준으로 guard한다.
- 로컬 read-only inspection은 quote-aware shell parsing과 제한된 read-only pipeline으로 허용된다.
- `npm run desktop:check`, `npm run paper:review-bench`, `npm run paper:report:controlled`, `npm run paper:report:full`, `npm run paper:report`는 검증/report command로 allowlist된다.
- 소스 수정 뒤 이미 떠 있는 MCP 서버 프로세스는 이전 action-policy snapshot을 유지할 수 있으므로, MCP `scopelease_guard`/`scopelease_approve` 결과를 최종 검증에 쓰기 전에는 MCP 서버를 재시작하거나 `scopelease attach`로 다시 연결한다.
