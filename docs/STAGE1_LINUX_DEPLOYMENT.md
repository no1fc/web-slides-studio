# 1단계: 정밀 편집 적용 및 검증

작성일: 2026-10-21. 원본 공유본 커밋: `029e4443b551e244db98f123c5d376d142fb3aea`.
0단계 기준 트리: `5e3878c881afd963fd4725057c43822461a1bb5c`.
이 문서는 공유 저장소 변경분의 인수인계다. 실제 Linux 운영 서버에는 배포하지 않았다.

## 추가 기능

- 개체 선택 시 모서리/변 크기 핸들 8개와 상단 회전 핸들.
- Shift 크기 조절: 외곽 비율 유지. Alt: 중심 기준 확대/축소. Shift 회전: 15도 단위.
- 속성 패널의 **크기 비율 유지**: 핸들과 너비/높이 수치 입력에 함께 적용. 다른 개체를 선택하면 해제.
- 방향키 1px, Shift+방향키 10px. 키를 누르고 있는 동안의 반복 이동은 한 번의 Undo.
- 화면 맞춤과 25/50/75/100/150/200% 배율. 100%는 문서 1920×1080의 1px를 화면 1px로 표시한다.
- 큰 캔버스는 스크롤바/휠/트랙패드로 이동한다. Shift+휠은 가로 이동이다. 배율을 바꿔도 선택 핸들이 따라간다.
- Escape, 포인터 취소·캡처 상실·창 이탈 시 미완료 드래그를 원복. 확정된 크기·회전은 자동 저장과 Undo/Redo에 반영.
- 장면/배경 선택값을 비동기 편집 확정 전에 보관하여 화면 갱신과 겹쳐도 유실되지 않도록 보완.

## 변경 파일

| 파일 | 내용 |
|---|---|
| public/bridge.js | 화면 좌표와 개체 크기 구분, 핸들, 조작 확정/취소, 키보드, 포커스, 휠 전달 |
| public/app.js | 스크롤 캔버스 배율, 비율 수치 입력, 지원 범위 표시, 장면/배경 입력 보존 |
| public/index.html, public/style.css | 배율·비율 UI, 스크롤 영역, 도움말 |
| test/editor-precision.test.js | 실제 Chrome의 정밀 조작·회전·배율·비율·포커스·휠 회귀 |
| test/editor-recovery.test.js | 프레임 갱신과 겹친 장면/배경 입력 검증 |
| docs/USER_GUIDE.md, docs/superpowers/ | 사용법과 구현 범위/검증 계획 |

런타임 의존성, lockfile, API 경로, 상태 schemaVersion은 변경하지 않았다. 기존 x/y/w/h/rotate patch를 사용한다. 배율과 비율 체크 상태는 문서에 저장하지 않는다. HTML/CSS·JSON·마스터 편집과 함께 사용할 수 있다.

## 지원 범위와 출력

크기 입력은 기존 CSS width/height 의미를 유지하며 content-box의 padding/border를 별도로 계산한다. 비율 고정은 테두리까지 포함한 외곽 비율로 통일했다. 기존 원본의 상대 translate 좌표 의미도 유지한다.

기본 개체 및 CSS rotate를 지원한다. transform/skew/3D, 조상 변환, inline 개체, 최소/최대 크기 제약 등 정밀 조작을 보장할 수 없는 경우 핸들을 숨기고 속성 패널에 설명한다. 모든 임의 HTML/CSS 레이아웃을 PowerPoint 개체로 변환하는 기능은 아니다. 화면 밖으로 완전히 이동한 개체는 JSON 또는 기존 Undo로 복구한다.

HTML과 PDF에는 브라우저에서 렌더링한 크기·회전이 반영된다. 편집형 PPTX 파일 생성과 텍스트 분리는 검증했으나, 기존 추출기는 회전 개체의 외접 사각형을 사용하므로 PowerPoint에서 위치·크기·줄바꿈이 웹과 달라질 수 있다. 외형이 우선이면 PDF 또는 이미지 기반 PPTX를 사용한다. PowerPoint 프로그램의 재편집·렌더링 동등성은 이후 호환성 단계에서 별도 검증한다.

## 패치 선택

전달 ZIP의 패치는 **하나만** 선택한다.

- 아직 0단계를 적용하지 않은 원본 공유본: `changes-from-original.patch` (0+1단계 통합).
- 이전 `web-slides-studio-stage0.zip`을 그대로 적용한 코드: `changes-from-stage0.patch` (1단계 증분).

`changed-files/`는 최종 파일 확인용이다. 실제 서버의 자체 변경이 있으면 전체 파일 덮어쓰기보다 해당 차이를 병합한다. 패치 두 개나 패치와 파일 복사를 중복 적용하지 않는다. 두 기준에 대한 적용 검증 결과와 변경 파일 SHA256은 전달 ZIP의 `VERIFICATION.txt`, `MANIFEST.json`을 확인한다.

## Linux 적용 순서

1. 현재 코드의 Git 상태, 운영 환경 설정, 서비스 이름, DATA_DIR 경로를 확인한다. 코드·설정·전체 DATA_DIR를 일관된 시점에 백업한다.
2. 운영과 분리한 스테이징 코드/데이터 복사본을 준비한다. 운영 DATA_DIR에 두 앱 프로세스를 동시에 연결하지 않는다.
3. 아래 예시 경로를 실제 스테이징 값으로 바꾼다.

```bash
APP_DIR=/actual/staging/web-slides-studio
PATCH_FILE=/actual/handoff/changes-from-stage0.patch
cd "$APP_DIR"
git status --short
git rev-parse HEAD
git apply --check "$PATCH_FILE"
git apply "$PATCH_FILE"
git diff --check
npm ci --no-audit --no-fund
export CHROME_PATH=/usr/bin/chromium
node --test test/editor-precision.test.js test/editor-foundation.test.js test/editor-recovery.test.js
npm test
```

`CHROME_PATH`는 실제 설치한 Chrome/Chromium 실행 파일로 지정한다. Node >=20 및 한글 폰트가 필요하다. 적용 검사가 실패하면 서버의 자체 변경과 충돌한 부분을 먼저 병합하고 다시 검사한다.

스테이징 구동과 origin/인증 설정은 `STAGE0_LINUX_DEPLOYMENT.md`의 절차를 따른다. 확인 후 기존 운영 방식으로 해당 Node 서비스 또는 Docker 이미지를 교체하고 재시작한다. public 파일 전체를 함께 배포하고 편집 페이지를 새로고침한다.

## 수동 합격 기준

1. 400×200 개체를 모서리 핸들로 480×240으로 조절. 반대 모서리 고정, 한 번 Undo/Redo, 저장 후 다시 열어 같은 크기.
2. 30도 회전한 개체에서 모서리를 당겨도 반대쪽 모서리 고정. padding/border가 있는 원본 제목에서도 같은 기준.
3. Shift와 비율 체크, Alt 중심 조절, Shift+회전 15도 단위. 취소 시 기존 x/y/w/h/rotate 모두 복구.
4. 선택한 채 50→100→200% 변경 후 핸들이 정확히 둘러싸는지 확인. 각 배율에서 문서 20px 이동 결과 동일.
5. 화면 맞춤에서 휠로 슬라이드 내용이 밀리지 않고, 확대하면 캔버스 영역이 가로/세로 스크롤되는지 확인.
6. 방향키 1px, Shift 10px, 길게 눌러 이동한 뒤 한 번 Undo. 입력창과 텍스트 편집 중에는 커서만 움직이며 개체 재선택 후 방향키 이동 가능.
7. OS 한글 IME의 조합·받침 수정·한/영 전환과 코드·JSON·마스터 저장을 확인. 자동 테스트의 composition 이벤트와 실제 OS IME 검사는 구분한다.
8. HTML ZIP/PDF/PPTX를 출력하여 이전 자료·템플릿·마스터와 새 회전 개체의 외형을 비교한다. 편집형 PPTX의 위 한계를 확인한다.

## 롤백

1단계는 0단계와 같은 스키마 및 patch 필드를 사용하므로 0단계 코드로 돌아가도 저장된 크기·회전 값은 남는다. 먼저 작업 중 입력을 저장하고 앱 쓰기를 멈춘 뒤 검증한 이전 코드로 복구한다. 새 편집 결과를 버리려면 앱의 버전 복원을 사용한다.

0단계 이전 원본 코드까지 되돌리는 경우 코드·설정·데이터 백업을 함께 복구해야 한다. 옛 validator가 새 코드/마스터 필드를 유실시킬 수 있다는 0단계 주의사항은 계속 적용된다.

## 검증 기록

Windows Node 22.14.0 / Chrome 156 환경에서 새 정밀 편집 시나리오와 기존 회귀를 실행했다. 핸들/배율/비율/포커스/휠 및 장면 설정 오류는 실패를 재현한 뒤 수정했다. 독립 검토에서 발견한 배율 오버레이와 content-box 비율 문제를 모두 수정했다. 최종 개수·로그 및 깨끗한 두 기준본에 대한 패치 적용 결과는 ZIP의 `VERIFICATION.txt`에 기록한다.

Linux 운영 서버, 실제 PowerPoint 앱 렌더링, OS 한글 IME 전체 수동 검증은 수행하지 않았다.
