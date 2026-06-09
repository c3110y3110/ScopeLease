# ScopeLease 한국 특허 초안 방향

이 문서는 최신 구현 기준의 특허 초안 방향만 정리한다. 이전 run 수치나 이전 평균 절감률은 현재 효과로 사용하지 않는다. 단, named frozen 13-repository, 102-pair command-reported protocol은 provider billing이 아닌 bounded command-reported evidence로만 분리 인용한다.

## 발명의 명칭 후보

**코딩 에이전트의 저장소 범위 컨텍스트 생성 및 서명된 승인 리스 기반 작업 제어 방법**

## 해결하려는 문제

AI 코딩 에이전트는 저장소 안에서 파일을 읽고, 코드를 수정하고, 명령을 실행한다. 기존 방식은 다음 문제가 있다.

1. 어떤 파일을 읽어야 하는지 넓게 탐색한다.
2. 사용자가 승인해야 할 권한 범위가 불명확하다.
3. 비슷한 승인 질문이 반복된다.
4. 승인 후 파일, 명령, 위험도가 바뀌어도 같은 승인처럼 취급될 수 있다.
5. 컨텍스트를 줄였을 때 중요한 파일이나 정책을 빠뜨렸는지 검증하기 어렵다.

## 핵심 구성

ScopeLease는 다음 구성의 조합으로 구현된다.

1. 저장소 파일, 심볼, import, test, docs, route, policy hit를 포함하는 repo-local graph 생성.
2. baseline hash와 현재 저장소 상태 비교.
3. 변경 파일과 graph 관계를 이용한 `readPlan`, `avoidPlan`, `traceLedger`, `symbolFrontier`, `reviewFrontier`, `permissionFrontier`, `stopFrontier` 생성.
4. compact `agentContract`와 `graphQueryHints`를 포함한 graph-query-first agent 입력 생성.
5. 코딩 에이전트 action을 read, apply_patch, run_tests, run_command, checkpoint, network, external_write 등으로 정규화.
6. `scopelease_guard`로 action별 allow/ask/deny 판단.
7. `ask_once`인 경우에만 사용자 승인에 따라 approval lease 생성.
8. approval lease에 request hash, baseline hash, riskMax, allowed actions, file scope, command scope, approved changed files, stopWhen, graph hashes, HMAC signature 포함.
9. 후속 action마다 lease signature와 scope 조건 재검증.
10. 연결된 Codex `PreToolUse` hook 또는 `scopelease guarded-exec` command wrapper를 통해 ask/deny action을 실행 전에 차단.
11. 범위 이탈, baseline 변경, 위험도 상승, command scope 이탈, shell compound command, external write, network, checkpoint 등은 새 승인 또는 deny.
12. 동일 task/workIntent/pairId의 default lane과 ScopeLease lane을 비교해 agent-visible 또는 command-reported delta를 산출.

## 가장 강한 청구항 축

가장 강한 축은 단순 KG가 아니라 다음 결합이다.

> repo-local graph와 baseline diff로 symbol-level frontier, compact agent contract, graph-query hints, review/permission/stop frontier를 만들고, 정규화된 agent action에 대한 guard decision에 결합된 HMAC-signed approval lease를 발급하여 후속 action을 재사용 승인, 검증, 무효화하는 방법.

## 특허에 넣어도 되는 구현 근거

| 기능 | 구현 위치 |
| --- | --- |
| graph/index | `src/core/indexer.js`, `src/core/impact.js`, `src/core/frontier.js` |
| compact context / agent contract | `src/core/adaptive-context.js`, `src/core/artifacts.js` |
| symbol and review frontier | `src/core/frontier.js`, `src/core/review-bench.js` |
| guard/decision | `src/core/guard.js`, `src/core/fatigue-controller.js` |
| HMAC approval lease | `src/core/approval-lease.js` |
| pre-execution enforcement | `src/core/enforcer.js` |
| pair metering | `src/core/pair-harness.js`, `src/core/evidence-export.js` |
| review frontier evaluation | `src/core/review-bench.js` |

## 현재 평가 원칙

정량효과는 source-of-truth snapshot에서 산출한다. 현재 bounded command-reported result는 named frozen 13-repository, 102-pair protocol에만 한정하고, live 평균 절감은 fresh C0/C3 paired snapshot이 있을 때만 주장한다.

필수 축:

1. completion 유지
2. context/token/call 감소 또는 signed delta
3. permission false allow/block
4. repeated approval prompt proxy
5. symbol/review-frontier omission/leakage/merge/intent 품질
6. provider billing, hidden token, human fatigue, universal sandbox claim 분리

## 쓰면 안 되는 표현

- Codex가 기본적으로 전체 저장소를 prompt에 넣는다.
- ScopeLease가 항상 provider 비용을 줄인다.
- ScopeLease가 모든 host tool 실행을 universal sandbox처럼 막는다.
- 사람의 인지 피로가 이미 감소했다고 단정한다.
- named frozen command-reported protocol을 live Codex/Claude 평균 절감이나 provider billing 절감으로 바꿔 말한다.

## 안전한 특허 표현

> 본 발명은 저장소 범위 graph와 baseline diff를 이용해 symbol-level frontier, compact agent contract, graph-query hints, 검토 범위 및 권한 범위를 생성하고, 사용자 승인으로 발급된 서명형 approval lease를 후속 action마다 검증하여, 승인 범위 내 action은 재사용 승인하고 범위 이탈 또는 stop condition 발생 시 새 승인 또는 거부를 수행한다.
