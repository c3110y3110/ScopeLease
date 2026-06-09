# ScopeLease 특허 패키지, 비전공자 검토용

이 폴더는 ScopeLease 특허 초안을 설명하기 위한 패키지다. 변리사에게 바로 넘기기 전, 발명자와 비전공 검토자가 같은 그림을 보도록 구성했다.

법률 문서가 아니라 기술 설명 패키지다. 최종 청구항, 권리범위, 선행기술 대응 문구는 변리사가 조정해야 한다.

## 읽는 순서

0. [../docs/current-research-memory.md](../docs/current-research-memory.md)  
   현재 특허/CHI framing, claim 가능한 범위, fresh-run 조건을 먼저 확인한다.

1. [01_non_specialist_overview.md](01_non_specialist_overview.md)  
   ScopeLease가 무엇이고 왜 특허 포인트가 되는지 쉽게 설명한다.

2. [02_examples_and_scenarios.md](02_examples_and_scenarios.md)  
   컨텍스트 경계 축소, 권한 lease, 반복 승인 질문 proxy가 어떤 상황에서 발생하는지 예시로 설명한다.

3. [03_implementation_mapping.md](03_implementation_mapping.md)  
   특허 구성요소가 현재 코드 어디에 구현되어 있는지 매핑한다.

4. [04_claim_draft.md](04_claim_draft.md)  
   독립항과 종속항 후보를 비전공자도 읽을 수 있는 형태로 정리한다.

5. [05_evidence_and_boundaries.md](05_evidence_and_boundaries.md)  
   실험 수치, claim 가능한 범위, claim하면 안 되는 범위를 분리한다.

6. [06_drawings_and_handoff.md](06_drawings_and_handoff.md)  
   특허 도면 후보, 변리사 전달 체크리스트, 다음 보강 항목을 정리한다.

## 핵심 발명 문장

> ScopeLease는 저장소 지식그래프와 기준점 비교로 코딩 에이전트가 먼저 볼 범위를 좁히고, 사용자가 승인한 작업 범위를 HMAC 서명된 approval lease로 저장하여 후속 에이전트 작업마다 요청, 기준점, 위험도, 파일 범위, 명령 범위, 중단 조건 및 서명을 재검증하는 방법이다.

## 패키지의 기준선

현재 패키지는 다음을 주장 가능한 범위로 둔다.

- 저장소 KG와 baseline diff 기반 compact context 생성
- `readPlan`, `avoidPlan`, `traceLedger`, `symbolFrontier`, `agentContract`, `graphQueryHints` 기반 agent 입력 및 검토 경계 생성
- action-specific `scopelease_guard` 판단
- HMAC-signed approval lease 생성 및 검증
- 연결된 host hook 또는 command wrapper를 통한 pre-execution enforcement
- shell compound command 우회 방지와 task-scoped internal network lease
- named frozen protocol에 한정된 paired command-reported token metering
- review-frontier, permission fixture, controlled C0-C3 mechanism evidence
- 반복 승인 질문 감소 proxy

현재 패키지는 다음을 주장하지 않는다.

- provider/API billing 비용 절감
- 연결되지 않은 host 또는 command wrapper 밖에서 실행되는 tool의 물리적 차단
- 완전한 sandbox 보안
- 모든 작업에서 보편적 live 평균 토큰 절감
- 사람의 심리적 피로 감소에 대한 직접 입증

일반 live 평균 효과 수치는 이 패키지의 상수로 취급하지 않는다. 같은 `workIntent`와 `pairId`를 가진 C0/C3 fresh run에서 나온 `fresh-run-snapshot.json`만 live 평균의 근거로 사용한다. 단, named frozen 13-repository, 102-pair command-reported protocol의 64% lower result는 provider billing이 아닌 bounded command-reported evidence로만 인용할 수 있다.

## 기존 루트 초안

루트의 [KOREAN_PATENT_DRAFT.md](../KOREAN_PATENT_DRAFT.md)는 단일 문서 초안이고, 이 폴더는 변리사 전달용 구성품을 나눈 패키지다.
