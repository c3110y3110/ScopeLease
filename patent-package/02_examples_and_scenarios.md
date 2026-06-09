# 02. 예시와 시나리오

이 문서는 특허 명세서에 넣을 수 있는 실시예를 비전공자용 예시로 풀어 쓴 것이다.

## 예시 1. 컨텍스트 절감

### 상황

사용자가 다음처럼 요청한다.

```text
인증 관련 변경이 테스트와 문서에 미치는 영향을 보고, 필요한 수정 범위를 제안해줘.
```

일반 에이전트는 저장소 안에서 인증, 테스트, 문서, 설정 파일을 넓게 찾을 수 있다. 어떤 파일이 중요한지 모르기 때문에 검색과 읽기가 늘어난다.

### ScopeLease 방식

ScopeLease는 먼저 저장소 지식그래프를 만든다.

```text
auth.js
  ├─ imports session.js
  ├─ tested by auth.test.js
  ├─ documented by auth.md
  └─ policy hit: auth/session-sensitive
```

그 다음 에이전트에게 전체 저장소 대신 다음과 같은 compact context를 준다.

```text
readPlan:
  1. src/auth.js - 변경된 인증 코드
  2. src/session.js - auth.js가 참조
  3. test/auth.test.js - 직접 테스트
  4. docs/auth.md - 관련 문서

avoidPlan:
  - unrelated UI files
  - generated dist files
  - external network actions

traceLedger:
  - auth.js changed since baseline
  - auth.js imports session.js
  - auth.test.js covers auth.js
  - policy hit: session-sensitive
```

### 특허에 넣을 포인트

이 예시는 "전체 저장소를 AI에게 넣는다"가 아니라 "저장소 그래프와 기준점 비교로 필요한 agent 입력만 구성한다"는 포인트를 보여준다.

## 예시 2. 승인 lease 재사용

### 상황

에이전트가 다음 작업을 하려 한다.

```text
src/auth.js와 test/auth.test.js를 수정하고 npm test를 실행
```

사용자는 이 범위가 맞다고 판단해 승인한다.

### ScopeLease 방식

ScopeLease는 다음과 같은 lease를 만든다.

```json
{
  "requestHash": "현재 사용자 요청의 해시",
  "baselineHash": "승인 당시 저장소 기준점 해시",
  "riskMax": "medium",
  "fileScopes": ["src/auth.js", "test/auth.test.js"],
  "commandScopes": ["npm test"],
  "approvedChangedFiles": ["src/auth.js", "test/auth.test.js"],
  "stopWhen": [
    "changed_file_outside_scope",
    "network_access_requested",
    "external_write_requested",
    "test_failure_without_known_cause"
  ],
  "signatureAlgorithm": "hmac-sha256",
  "signature": "..."
}
```

이후 같은 요청 범위 안에서 `src/auth.js` 수정과 `npm test` 실행은 반복해서 다시 묻지 않고 진행될 수 있다. 그러나 lease는 매번 검증된다.

### 특허에 넣을 포인트

승인은 단순 캐시가 아니다. 요청, 기준점, 파일, 명령, 위험도, 중단 조건, 서명에 묶인 재사용 가능한 승인 객체다.

## 예시 3. 범위 밖 파일 수정 차단

### 상황

승인된 파일은 다음 두 개다.

```text
src/auth.js
test/auth.test.js
```

그런데 에이전트가 다음 파일까지 바꾸려 한다.

```text
src/billing.js
```

### ScopeLease 방식

ScopeLease는 후속 action을 검증한다.

```text
fileScopes 안에 src/billing.js가 없음
→ lease 검증 실패
→ 새 승인 필요 또는 거부
```

### 특허에 넣을 포인트

approval lease는 사용자의 한 번 승인을 무제한 위임으로 바꾸지 않는다. 파일 범위가 바뀌면 lease가 재사용되지 않는다.

## 예시 4. 안전 테스트 명령 위장 방지

### 상황

사용자가 `npm test` 실행을 허용했다.

하지만 에이전트가 다음 명령을 실행하려 한다.

```bash
npm test && rm -rf .
```

겉으로는 `npm test`로 시작하지만, 뒤에 위험한 명령이 붙어 있다.

### ScopeLease 방식

ScopeLease는 shell control operator를 감지한다.

```text
명령에 && 포함
→ 단순 safe test command로 보지 않음
→ command scope 자동 확장 금지
→ deny 또는 ask_once
```

다음 명령들도 같은 이유로 안전 테스트로 보지 않는다.

```bash
npm test | ...
npm test > ...
npm test ; ...
$(...)
`...`
```

### 특허에 넣을 포인트

명령 prefix가 같다고 같은 권한으로 보지 않는다. 승인 lease의 command scope는 compound command로 자동 확장되지 않는다.

## 예시 5. 기준점이 바뀐 경우

### 상황

사용자가 승인한 뒤, 다른 프로세스나 사용자가 저장소를 바꿨다.

### ScopeLease 방식

후속 action이 들어오면 ScopeLease는 현재 기준점과 lease의 `baselineHash`를 비교한다.

```text
lease.baselineHash != currentBaselineHash
→ 승인 당시와 저장소 상태가 다름
→ lease 재사용 금지
→ 새 guard 판단 필요
```

### 특허에 넣을 포인트

승인 lease는 시간만으로 제한되는 것이 아니라 저장소 상태에도 묶여 있다.

## 예시 6. 반복 승인 질문 감소 proxy

### 일반 방식

사용자가 여러 번 질문을 받는다.

```text
auth.js를 읽어도 될까요?
session.js를 읽어도 될까요?
auth.test.js를 수정해도 될까요?
npm test를 실행해도 될까요?
다시 npm test를 실행해도 될까요?
```

### ScopeLease 방식

ScopeLease는 사용자에게 한 번에 다음처럼 묻는다.

```text
에이전트가 하려는 일:
- src/auth.js와 test/auth.test.js를 수정
- npm test 실행

하지 않을 일:
- 네트워크 접근
- 저장소 밖 파일 쓰기
- checkpoint 또는 merge

다시 물을 조건:
- 범위 밖 파일 변경
- 위험한 명령 실행
- 테스트 실패 원인 불명
```

사용자가 승인하면 같은 범위의 반복 질문은 lease hit로 처리된다.

### 특허에 넣을 포인트

심리적 피로 감소는 사람 대상 연구가 필요하지만, 반복 승인 질문 수를 줄이는 구조와 proxy 지표는 구현되어 있다.

## 예시 7. paired metering

### 상황

같은 작업을 두 lane으로 실행한다.

```text
default-codex lane:
  일반 작업공간에서 Codex 실행

scopelease-codex lane:
  ScopeLease readPlan으로 좁힌 작업공간에서 Codex 실행
```

### 측정

같은 `workIntent`와 `pairId`를 가진 결과만 비교한다.

```text
default tokens = n
scopelease tokens = m
delta = n - m
reduction = (n - m) / n
```

단, `n > m`일 때만 절감률로 보고한다. `m > n`이면 overhead로 보존한다.

### 특허에 넣을 포인트

토큰 절감률을 임의로 주장하지 않고, 같은 작업 pair의 관측값으로 계산한다. provider billing과 agent-visible 또는 command-reported token은 분리한다.
