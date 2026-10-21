# 2단계: 여러 개체 배치와 레이어

승인된 로드맵과 사용자의 구현·GitHub 업로드 요청을 실행한다. 기존 plain JS/Node 구조와 schemaVersion 1을 확장하고 실제 서버 배포는 사용자가 수행한다.

## 동작

- Shift/Ctrl/Command 클릭 선택 토글, 빈 슬라이드 영역 드래그로 완전히 포함된 개체 선택, Ctrl/Command+A 전체 선택. 잠금/숨김 개체 제외. 슬라이드 전환·Escape 선택 해제.
- 다중 선택 이동·방향키·숨기기는 한 번의 history/저장 작업. 드래그 취소는 전체 원복. 다중 선택에는 단일 개체 크기/회전 핸들을 표시하지 않는다.
- 복제 및 앱 내부 복사/붙여넣기. 새 ID, 24px 오프셋, 독립 편집, 같은 자료의 다른 슬라이드로 붙여넣기. 기본 글·이미지·도형과 지원 HTML의 서식을 복제 시점의 HTML/CSS 스냅샷으로 유지. JS/외부 자산/지원하지 않는 구성은 전체 복제를 거절하고 이유를 표시한다.
- 좌/가운데/우, 위/중간/아래 정렬은 선택 개체들의 외접 사각형 전체 기준. 가로/세로 분배는 3개 이상, 양 끝 고정 및 사이 간격 동일. CSS 변환 지원 범위는 1단계와 같고 불가능한 조합은 전체 명령을 거절한다.
- 레이어 목록에서 가려진 개체 선택, 숨김/표시, 잠금/해제, 맨 앞/뒤 및 한 단계 앞/뒤 이동. 순서는 같은 DOM 부모의 편집 개체 사이에서 적용. 서로 다른 컨테이너의 stacking context는 평탄화하지 않는다.
- 잠금은 편집기 조작 보호이며 JSON/코드 편집을 통한 명시적 변경을 막는 권한 기능이 아니다.

## 계약

- patches에 locked:boolean, z:integer[-100000,100000], layerPosition:'relative' 추가. 정적 개체의 z-index 적용 시 relative/inset:auto로 기존 문서 흐름을 보존한다.
- added.kind='html', html:string 추가. 내용에는 data-sd-id/id 등 복제 ID를 남기지 않고 서버에서 기존 HTML/CSS 허용 규칙으로 정규화한다. 단일 최상위 HTML 요소를 편집 개체로 유지하고 여러 최상위 요소는 wrapper로 묶어 하나의 편집 ID를 가진다. 자산 참조 검증/삭제 보호/저장·복원·복제·HTML 출력에 포함한다.
- bridge→parent: select {element: singleOrNull,elements:[info]}, batch-change {changes:[{id,patch}]}, layers {slide,items:[{id,tag,label,locked,hidden,z,group,layerable,selected}]}, objects {operation:'copy'|'duplicate',slide,objects:[addedWithoutIdSlide]}, paste {}, notice {message}.
- parent→bridge: command {name}, select-ids {ids}, layer-toggle {id,key:'locked'|'hidden'}.
- command names: align-left/center/right/top/middle/bottom, distribute-x/y, front/back/forward/backward, duplicate/copy, hide, lock.
- 기존 change {id,patch}, select.element, commit-edit, patch, settings, go, ready 계약을 유지한다.

## 완료 기준

다중 동작 한 Undo, 전체 취소, 50/100/200% 좌표, 회전 개체 정렬, 잠금 보호, 독립 복제와 새 ID, 자산 보존, 순서의 저장 왕복/HTML 출력, 기존 전체 회귀 통과. GitHub 최신 main과 충돌 없이 통합 후 업로드하고 원격 SHA를 확인한다. 적용 방법과 알려진 출력 한계를 문서화한다.
