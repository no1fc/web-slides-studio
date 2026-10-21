# 0단계 및 코드·마스터 편집 설계
사용자 승인 범위: 공유본의 저장·좌표·선택 수정, HTML/CSS와 JSON 편집 모두, 템플릿/슬라이드 마스터의 사용 가능한 기초, Linux 적용·검증 문서. 운영 배포는 하지 않는다.

- 기준: 029e4443, 작업 폴더는 분석용 전용 clone, branch codex/stage0-code-templates. 새로운 worktree 대신 이미 분리된 공유본에서 작업한다.
- schemaVersion: 1. 없는 버전은 legacy로 읽기 변환하되 과거 파일을 덮어쓰지 않는다. 미래 버전/알 수 없는 최상위 속성을 명시적으로 거절한다.
- 상태 확장: slideCode: {slideId:{html,css}}, masters:{masterId:{name,html,css}}, slideMasters:{slideId:masterId}. 기본값은 빈 객체. 기존 여섯 필드는 유지.
- 코드 편집은 슬라이드 내부 HTML 및 추가 CSS. 기존 원본 HTML 파일을 덮어쓰지 않는다. HTML/CSS는 content origin 안에서만 렌더링하며 신규 코드의 script/event/iframe 등 실행 요소는 거절한다. 기존 가져온 자료의 스크립트 정책은 그대로.
- GET /api/decks/:id/authoring?slide=... => {slide,html,css}. 현재 override 또는 원본 슬라이드의 기초 HTML. POST /api/decks/:id/validate {state} => {state} 검증/정규화만. 저장은 기존 revision save 경로 사용.
- code 요소는 안정된 data-sd-id를 부여하여 개체 편집 가능. 삭제된 코드 요소의 patch는 UI 적용 과정에서 정리한다. 원본/추가 개체의 기하 의미를 변경하지 않는다.
- 마스터는 이름+공통 HTML/CSS를 가진 장식 레이어이며 슬라이드별 참조로 연결. 연결된 슬라이드에 업데이트 전파, 해제/복제/복원 지원. PPTX native master/placeholder 편집은 이번 범위 아님.
- 템플릿은 표지/제목본문/2단비교 프리셋으로 슬라이드 코드 구성을 생성. 마스터 프리셋은 공통 브랜드/제목 영역 출발점. 데이터와 HTML 출력에 유지.
- 브리지는 added 기본값+patch를 병합하여 위치를 읽고 변경한다. 드래그 미리보기/확정/취소, pointercancel/Escape, 슬라이드 이동·빈 공간 클릭 선택 해제, IME 확정 입력 유지.
- 저장은 최신 편집을 오래된 응답으로 덮지 않고, 서버 정규화 상태를 반영. 실패/409에서 변경 보존. 구조 변경/Undo는 기존 보호 흐름을 유지한다.
- 테스트: schema/legacy/unknown fields, 한 축 이동, 실제 브라우저 drag/undo/cancel/selection, 코드/JSON/master 작성 저장 복제 복원 HTML/PPTX, 보안 경계, 느린 저장 중 후속 편집.
- 전체 기존 테스트 baseline과 최종 suite 실행. Windows 실제 Chrome; Linux 서버 실행 결과는 따로 필요.
