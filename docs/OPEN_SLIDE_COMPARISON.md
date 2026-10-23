# open-slide 분석과 SDLAB 적용

참조: [open-slide/open-slide](https://github.com/open-slide/open-slide/tree/1f18ab5970fa5e68219b8ff1811799d5018122cd), 커밋 `1f18ab5970fa5e68219b8ff1811799d5018122cd`. 라이선스는 MIT, 저작권 표기는 2026 Yiwei Ho다. 이번 변경은 공개 소스의 구조와 동작 아이디어를 참고해 기존 SDLAB 코드로 구현했으며, React 런타임·아트·테마 코드를 복사하거나 의존성으로 설치하지 않았다.

## 분석 방법과 경계

REA 6.5.0으로 댓글/출력 관련 TS·TSX 5개와 manifest, 탐색/글꼴/캡처/OOXML 관련 TS·TSX 6개를 정적으로 분석했다. 파싱 실패는 없었다. SDLAB은 공개 코드 5개를 별도 임시 폴더에 복사하여 대조했다. 운영 데이터·인증정보·node_modules는 분석하지 않았다. REA 그래프는 선택한 코드 범위의 정적 관찰과 추론이며 실제 open-slide 실행 또는 전체 저장소 동작 검증을 의미하지 않는다. 미선택 파일·동적 관계는 미확인이다.

- 댓글/출력 Evidence: `ev_3f569caf787b30df74da484518522c6bd14e7457ab459b04cbc7ce8f03934756`
- 탐색/출력 Evidence: `ev_8a142ddd9f49400d92553d02ef5473a783ebb1dcfd2741ad8537d2d89b823970`
- SDLAB 비교 Evidence: `ev_7e6c29c3a7dd5e91ca83e3b41aa15e257d41268d0f384f9559238b70345e3912`

요약·선택 파일·한계·소스 해시는 인접 `open-slide-rea-evidence.json`, `open-slide-editor-export-evidence.json`에 보존한다. 기능 결론은 아래 소스 확인과 SDLAB의 실제 브라우저·출력 파일 검사로 보강한다.

## 구조와 중복 기능 비교

| 영역 | open-slide에서 관찰한 구조 | SDLAB에 적용하는 판단 |
| --- | --- | --- |
| 제작·저장 | React 페이지 + Vite, 소스 파일을 직접 수정 | 기존 HTML 자산 + 검증된 상태 + 불변 revision을 유지. React 전환은 기존 자료·이력의 호환성 비용이 크다. |
| 도구 탐색 | `command/slide-command-menu.tsx`가 기존 콜백을 명령으로 노출 | 기존 버튼 동작을 검색으로 호출하여 저장/충돌 로직을 중복 구현하지 않는다. |
| 전체보기 | `overview-grid.tsx`의 슬라이드 그리드 탐색 | 기존 지연 로딩 썸네일 목록을 재사용하고 이동 전 편집을 저장한다. |
| 수정 요청 | `inspector/comment-layer.tsx`의 개체/영역 대상, `use-comments.ts` HTTP, `vite/routes/comments.ts`가 JSX에 마커 저장 | 안정적인 SDLAB 슬라이드/개체 ID와 별도 비공개 파일 사용. 요청이 발표 원본·공유 출력에 들어가지 않게 한다. |
| AI 적용 | 소스 마커를 읽어 코드 수정 후 마커 정리 | 읽기 전용 MCP 요청 조회 → 기존 변경안 비교/선택 적용 → 사용자가 완료 표시. 자동 덮어쓰기와 자동 완료는 하지 않는다. |
| 정적 출력 | `pptx/render.ts`, `export-pptx.ts`가 캡처 전 CSS 동작을 안정화 | 출력 전용 브라우저에서 유한 효과 완료·무한 장식 현재 프레임 정지. 원본/HTML/발표는 그대로 유지한다. |
| PPTX 링크 | `pptx/scene.ts`, `pptx/ooxml.ts`에 링크 관계 없음 | open-slide 기능을 가져오는 것이 아니라, 비교에서 드러난 SDLAB의 기존 부족분을 설치된 PptxGenJS로 보완한다. |
| PPTX 글꼴 | `pptx/fonts.ts`가 가용 글꼴을 해결 | CSS 첫 이름만 기록하던 출력 경로에서 브라우저가 확인한 대체 글꼴을 활용한다. 다른 PC 글꼴 설치까지 보장하지 않는다. |
| 템플릿·테마 | design token과 서로 다른 페이지 구성을 활용 | 기존 테마 변수와 편집 가능한 DOM을 유지하며 보고/강의/제안 템플릿의 시각 계층과 구성을 개선한다. |
| 발표·공유 | 발표 모드·노트·타이머, 정적 배포 | 최근 검증한 SDLAB 발표자/청중 분리와 서버 암호·만료·철회 정책은 보존한다. |

## 사용자 흐름

편집기에서 **도구 찾기**, **전체 슬라이드**, **도구 접기**로 작업 공간과 탐색을 조절한다. 개체에 수정 요청을 남기거나 파일의 요청 목록에서 슬라이드 전체 요청을 만든다. 프롬프트를 외부 AI에 복사하면 MCP 0.4.0이 요청을 읽고 변경안을 제출한다. 사용자가 비교·적용한 뒤 요청을 완료 처리한다. 삭제된 대상과 요청 후 변경된 자료는 명시적으로 표시된다.

요청은 최대 500개를 보관하며 자료 버전과 별개다. 템플릿·복제·공유·발표·HTML/PPTX에는 포함하지 않는다. 이전 MCP는 업데이트 후 재시작해야 새 도구가 표시된다.

## 검증 기록

최종 회귀·브라우저·Windows/Linux MCP CI·운영 반영 결과는 변경 이력과 인스턴스 운영 기록에 남긴다. 실제 PowerPoint·Safari·다중 모니터 실기와 arbitrary JavaScript/Three.js의 완료 상태는 별도 수동 검사가 필요하다. PDF는 정지 이미지 출력이며 링크는 지원하지 않는다.
