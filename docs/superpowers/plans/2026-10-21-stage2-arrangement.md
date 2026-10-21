# Stage 2 Arrangement Implementation Plan

> **For agentic workers:** Use focused independent agents for storage and parent UI, with the coordinator owning bridge gestures and integration. Run one fresh-context review before publishing.

**Goal:** 다중 선택·복제·정렬·분배·레이어를 구현하고 검증된 결과를 GitHub에 업로드한다.

**Architecture:** bridge가 실제 DOM 기하와 선택·일괄 명령을 담당한다. 부모는 history·저장·복제 상태·레이어 UI를 담당하며 서버가 새 필드를 검증/렌더링한다.

**Tech Stack:** Plain JavaScript, Node >=20, 기존 Playwright/Chrome. 새 의존성 없음.

**Spec:** ../specs/2026-10-21-stage2-arrangement-design.md

## Global Constraints

- 현재 단계 및 0·1단계 변경을 함께 보존한다. 원격 변경을 강제 덮어쓰지 않는다.
- 사본은 새 ID와 독립 스냅샷. 부분 실패 시 일부만 생성하지 않는다.
- 기존 스키마를 하위 호환 확장하며 전체 command 단위로 Undo한다.

## Review Focus

- 잠금 개체가 포인터·키·부모 속성 명령으로 변경되지 않는가.
- 선택 내 부모/자식 중복과 슬라이드 전환 후 지연 메시지가 잘못 적용되지 않는가.
- 복제의 자산·서식·ID와 원본 수정 독립성이 유지되는가.
- 레이어와 정렬이 회전/중첩/flow 레이아웃에서 명시된 범위를 지키는가.
- 저장 오류 및 취소가 일괄 상태를 부분 적용하지 않는가.

## Tasks

- [x] 서버: 새 patch와 html 개체 검증·렌더링·자산 참조, 실패 먼저 확인한 저장/출력 테스트.
- [x] 부모 UI: 다중 선택·레이어 패널과 메시지, 일괄 history, 복제/내부 clipboard 원자적 적용.
- [x] bridge: 선택 집합·영역 선택·일괄 이동/키보드·정렬/분배·레이어·스냅샷 복제와 브라우저 테스트.
- [x] 통합: 기존 전체 회귀와 새 시나리오, 화면/출력 검증, 독립 코드 검토 및 결함 수정.
- 전달 절차: Linux 재배포 문서와 검증 코드를 커밋한 뒤 GitHub main 업로드, 원격 SHA·트리 일치를 확인한다.

## 검증 결과

2026-10-21 Windows Node 22.14.0 / Chrome 156에서 `npm test` 89/89 통과. 1280×800 및 1600×1050 화면을 확인했다. 독립 검토에서 발견한 잠긴 형제 레이어 저장, 복제 텍스트의 서식·회전 원점, 검증 실패 후 후속 편집 복구 문제를 재현 검사로 수정했다. Linux 적용 방법과 한계는 `docs/STAGE2_LINUX_DEPLOYMENT.md`에 기록했다.
