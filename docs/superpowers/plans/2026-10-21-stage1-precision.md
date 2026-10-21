# Stage 1 Precision Editing Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan sequentially; request one fresh-context review at the end.

**Goal:** 0단계 편집기에서 단일 개체 크기·회전·키보드 이동·확대/축소를 정확하게 지원한다.

**Architecture:** public/bridge.js가 선택 오버레이와 포인터/키보드 트랜잭션을 소유한다. public/app.js는 배율과 속성 UI를 관리한다. 기존 change/select/commit-edit 메시지와 state.patches를 유지한다.

**Tech Stack:** Plain JavaScript, Node.js >=20, Playwright/Chrome. 의존성 추가 없음.

**Spec:** ../specs/2026-10-21-stage1-precision-design.md

## Global Constraints

- 스키마 version 1과 기존 CSS width/height 및 상대 translate 의미를 유지한다.
- 문서 1920×1080, 좌표 ±5000, 크기 1..5000, 회전 ±360.
- Linux 운영 코드와 데이터를 변경하지 않는다.

## Review Focus

- 회전 및 content-box padding/border에서 반대쪽 고정점이 움직이지 않는가.
- 포인터 캡처 상실·Escape·창 이탈 후 임시 patch가 저장되지 않는가.
- 키 반복·IME·폼·숫자 입력과 방향키 개체 이동이 충돌하지 않는가.
- 확대된 iframe과 스크롤에서 핸들 위치와 문서 좌표가 일치하는가.
- 원본 HTML transform과 크기 제약이 있는 개체를 잘못 변형하지 않는가.

## Task 1: 포인터 정밀 조작

Files: public/bridge.js, test/editor-precision.test.js.
Interfaces: 기존 change {id,patch}, select {element}; select에 precisionReason 추가 가능.

- [x] 실제 브라우저 테스트 작성: 400×200 개체를 (80,40) 늘리면 480×240, 반대 모서리 고정, 한 change/Undo; 회전·content-box·Shift·Alt·취소 검증.
- [x] 신규 테스트 실패 확인 후 고정 화면 크기의 오버레이, 크기와 회전 계산, 제스처 전체 원복 구현.
- [x] 테스트 통과, 기존 foundation 회귀 확인.

## Task 2: 배율·키보드·비율 UI

Files: public/app.js, public/index.html, public/style.css, public/bridge.js, test/editor-precision.test.js.
Interfaces: settings {lockAspect:boolean}; 선택 시 precisionReason; 배율은 부모 iframe 크기로만 처리.

- [x] 실패 테스트: 방향키 1/10px와 반복 한 Undo, 입력 보호, 수치 비율 유지, 50/100/200%에서 20px 이동 동일.
- [x] 키 트랜잭션, 비율 체크, 스크롤 뷰포트와 화면 맞춤 구현.
- [x] 새 테스트 및 전체 npm test 통과.

## Task 3: 검토·Linux 전달

Files: docs/STAGE1_LINUX_DEPLOYMENT.md, docs/USER_GUIDE.md, qa 검증 결과, 별도 stage1-handoff/ 패키지.

- [x] 새 컨텍스트 코드 검토 후 중요한 결함은 재현 테스트와 함께 수정.
- [x] 화면 캡처, HTML/PDF/PPTX 생성과 저장 재열기 확인; 출력 한계 기록.
- [x] 원본 공유본 기준 통합 패치와 0단계 대비 증분 패치 작성. 깨끗한 기준 코드에 적용 및 바이트 대조.
- [x] 전체 테스트 결과, 파일 목록·해시, 서버 적용/롤백 절차 전달.
