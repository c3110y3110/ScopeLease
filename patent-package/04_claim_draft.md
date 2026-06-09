# 04. 청구항 후보

이 문서는 변리사가 다듬기 전의 청구항 후보를 담는다. 비전공자도 이해할 수 있도록 풀어 썼고, 실제 출원 문장에서는 용어와 권리범위를 더 정밀하게 조정해야 한다.

## 추천 발명의 명칭

다음 중 하나가 적합하다.

1. 코딩 에이전트의 저장소 범위 컨텍스트 주입 및 서명된 승인 lease 기반 작업 제어 방법
2. 저장소 지식그래프 및 기준점 해시를 이용한 코딩 에이전트 승인 lease 검증 방법
3. 코딩 에이전트 작업의 compact context 생성 및 범위 제한 승인 재사용 방법

## 독립항 후보 1

컴퓨터가 수행하는 코딩 에이전트 작업 제어 방법에 있어서,

1. 프로세서가 저장소의 파일, 심볼, import 관계, 테스트, 문서, route 및 정책 hit를 포함하는 저장소 지식그래프를 생성하는 단계;
2. 상기 프로세서가 저장소 기준점 해시와 현재 저장소 상태를 비교하여 변경 파일 또는 변경 심볼을 산출하는 단계;
3. 상기 저장소 지식그래프와 상기 변경 파일 또는 변경 심볼을 이용하여 코딩 에이전트가 우선 읽을 범위와 피할 범위를 포함하는 compact context를 생성하는 단계;
4. 상기 compact context가 `readPlan`, `avoidPlan` 및 `traceLedger` 중 하나 이상을 포함하는 단계;
5. 상기 저장소 지식그래프 또는 외부 code graph payload를 공통 operational graph로 정규화하는 단계;
6. 상기 operational graph로부터 agent 입력용 context frontier, 사용자 검토용 review frontier, 위임 가능한 permission frontier 및 중단 조건용 stop frontier를 산출하는 단계;
7. 코딩 에이전트가 수행하려는 작업을 읽기, 파일 수정, 패치 적용, 테스트 실행, 명령 실행, 네트워크 접근, 외부 파일 쓰기 또는 체크포인트 작업 중 하나 이상으로 정규화하는 단계;
8. 정규화된 작업에 대해 허용, 승인 필요 또는 거부 중 하나의 guard 판단을 생성하는 단계;
9. 사용자 승인에 응답하여 요청 해시, 기준점 해시, graph scope hash, 허용 위험도, 허용 작업, 차단 작업, 파일 범위, 명령 범위, 승인 당시 변경 파일, 허용 graph node 및 중단 조건을 포함하는 approval lease를 생성하는 단계;
10. 상기 approval lease에 HMAC 서명을 부여하는 단계;
11. 후속 코딩 에이전트 작업이 발생할 때마다 상기 approval lease의 서명, 요청 해시, 기준점 해시, graph scope hash, 위험도, 파일 범위, 명령 범위, 허용 graph node 및 중단 조건을 검증하는 단계;
12. 코딩 에이전트 도구 실행 전 집행 지점이 호출되는 경우, 상기 검증 결과가 유효할 때에만 도구 실행을 허용하는 단계;
13. 상기 검증 결과에 따라 후속 작업을 허용하거나, 새 사용자 승인을 요구하거나, 후속 작업을 거부하는 단계를 포함하는 방법.

## 독립항 후보 2

코딩 에이전트에 제공되는 입력 컨텍스트를 제어하는 컴퓨터 구현 방법에 있어서,

1. 저장소의 파일 및 심볼 관계를 포함하는 저장소 지식그래프를 생성하고,
2. 저장소 기준점과 현재 상태의 차이를 이용해 영향 경로를 산출하고,
3. 상기 영향 경로를 이용해 에이전트 입력용 compact context와 화면 표시용 지식그래프 데이터를 분리 생성하고,
4. 상기 compact context에는 읽기 계획, 회피 계획 및 추적 장부를 포함시키고,
5. 같은 작업 의도에 대해 기본 에이전트 lane과 compact context 적용 lane을 pair로 기록하고,
6. 상기 pair가 동일 작업 의도 및 동일 pair 식별자를 가질 때만 token delta를 산출하는 방법.

이 독립항은 token/context 쪽에 초점을 둔다. 다만 가장 강한 독립항은 approval lease가 포함된 후보 1이다.

## 종속항 후보

1. 상기 approval lease는 저장소 내부가 아닌 저장소 외부 위치에 보관된 서명 키를 이용해 HMAC 서명되는 방법.
2. 상기 서명 키의 저장 위치가 저장소 내부 경로로 확인되면 lease 생성을 거부하는 방법.
3. 상기 approval lease의 payload가 변경되면 서명 검증 실패로 lease를 무효화하는 방법.
4. 상기 approval lease는 정규화된 작업에 대한 guard 판단이 `승인 필요`인 경우에만 생성되는 방법.
5. 상기 guard 판단은 네트워크 접근, 외부 파일 쓰기 또는 경로 이탈을 hard deny로 분류하는 방법.
6. 상기 명령 범위 검증은 shell control operator를 포함하는 compound command를 안전 테스트 명령으로 분류하지 않는 방법.
7. 상기 shell control operator는 `&&`, `||`, `;`, `|`, redirection, backtick 또는 command substitution 중 하나 이상을 포함하는 방법.
8. 상기 명령 범위가 `npm test`를 포함하더라도 `npm test && 추가 명령`은 같은 명령 범위로 자동 판정하지 않는 방법.
9. 상기 approval lease는 승인 당시 변경 파일 목록을 포함하고, 후속 작업에서 승인 당시 변경 파일 밖의 변경이 감지되면 무효화되는 방법.
10. 상기 approval lease는 체크포인트, merge 또는 상태 확정 작업을 기본 차단 작업으로 포함하는 방법.
11. 상기 compact context는 화면 표시용 전체 지식그래프 데이터를 포함하지 않고, 우선순위가 부여된 agent-visible context만 포함하는 방법.
12. 상기 review frontier는 변경 파일, 변경 심볼, 영향 경로, 테스트 경로, 문서 경로 및 정책 hit 중 하나 이상을 포함하는 방법.
13. 상기 permission frontier는 승인 가능한 파일 노드와 action 노드를 포함하고, approval lease는 후속 action의 graph node가 상기 permission frontier 안에 있는지 검증하는 방법.
14. 상기 stop frontier는 네트워크 접근, 외부 파일 쓰기, 체크포인트, 기준점 graph 변경 또는 신규 정책 node 중 하나 이상을 포함하는 방법.
15. 상기 paired metering은 provider 과금량과 command-reported token 또는 agent-visible input token을 분리 기록하는 방법.
16. 상기 paired metering은 delta가 음수인 pair를 절감률에서 제외하지 않고 overhead pair로 보존하는 방법.
17. 상기 guard 판단은 사용자에게 에이전트가 수행할 작업, 수행하지 않을 작업 및 다시 묻는 조건을 자연어로 표시하는 방법.
18. 상기 compact context는 task type, 정책 hit, 변경 파일 및 테스트 경로 중 하나 이상에 따라 자동으로 좁혀지거나 넓어지는 방법.
19. 상기 실행 전 집행 지점은 PreToolUse hook 또는 command wrapper이고, Bash, patch, edit 또는 write 작업 실행 전에 guard 및 approval lease 검증을 호출하는 방법.
20. 상기 실행 전 집행 지점은 승인 필요 또는 거부 판단을 수신하면 비정상 종료 코드로 host tool 실행을 중단하는 방법.

## 핵심 권리범위

가장 방어 가능한 권리범위는 다음 조합이다.

```text
repo-local KG
+ baseline diff
+ readPlan / avoidPlan / traceLedger
+ operational graph adapter
+ context/review/permission/stop frontier
+ normalized agent action
+ guard decision
+ HMAC-signed approval lease
+ request/baseline/graph-scope/risk/file/command/stop condition validation
+ connected PreToolUse/command-wrapper enforcement point
```

## 피해야 할 청구항 방향

아래 방향은 너무 넓거나 현재 구현과 어긋난다.

- AI가 코드 지식그래프를 이용해 코드를 수정하는 방법
- MCP로 코딩 에이전트에 컨텍스트를 제공하는 방법
- AI 코드리뷰에서 위험 파일을 찾는 방법
- 모든 host의 모든 에이전트 도구 실행을 무조건 사전에 강제 차단하는 방법
- provider billing 비용을 절감하는 방법

## 명세서에 넣을 효과 문장

다음 문장은 현재 근거와 잘 맞는다.

> 본 발명은 저장소 전체 또는 전체 지식그래프를 코딩 에이전트 입력으로 제공하지 않고, 변경 집합과 저장소 지식그래프 관계로부터 생성된 compact context를 제공함으로써 지정된 paired command protocol에서 코딩 에이전트의 command-reported token 사용량을 줄일 수 있다.

> 또한 본 발명은 사용자가 승인한 범위를 HMAC 서명된 approval lease로 저장하고, 후속 작업마다 요청, 기준점, 위험도, 파일 범위, 명령 범위 및 중단 조건을 검증함으로써 반복 승인 요청을 줄이면서도 범위 이탈 시 재승인 또는 거부가 가능하게 한다.

> 연결된 PreToolUse hook 또는 command wrapper를 사용하는 실시예에서는 상기 검증이 도구 실행 전에 수행되며, 승인 필요 또는 거부 판단이 반환되면 host tool 실행을 중단한다.
