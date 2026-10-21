# 0단계·코드·마스터 편집: Linux 적용 및 검증

기준 공유본: 029e4443b551e244db98f123c5d376d142fb3aea
작업 브랜치: codex/stage0-code-templates
작성일: 2026-10-21
실제 운영 서버에는 접속하거나 배포하지 않았다. 이 패치는 공유본 기준이며 실제 Linux 코드와 차이를 먼저 확인해야 한다.

## 변경 내용

| 파일 | 변경 |
|---|---|
| public/app.js | 저장 응답이 후속 편집을 덮지 않도록 처리, 현재 선택 검증·해제, 입력 확정 확인, 코드/마스터 포함 복제 |
| public/bridge.js | added+patch 좌표 병합, 드래그 확정/취소, 선택 해제, 텍스트·IME 이벤트와 명령 분리 |
| public/authoring-ui.js (신규) | HTML/CSS·JSON 편집, 레이아웃 생성, 마스터 작성·연결·해제·삭제, 실패 초안 재편집 |
| public/index.html / style.css | 도구 버튼과 코드 편집 창 |
| src/deck.js | schemaVersion 1, 하위 호환 읽기 변환, 알 수 없는 필드 거절, 코드·마스터 상태 검증/렌더링, 좌표 병합 |
| src/authoring.js (신규) | 코드 정규화·개체 ID, CSS 범위, 마스터 레이어, 자산 참조 검증 |
| src/store.js | 이전 revision을 덮어쓰지 않는 읽기 변환, 신규 코드의 자산 존재 검사 |
| src/server.js | 인증된 authoring 조회/validate API와 UI JS 경로 |
| test/authoring.test.js (신규) | 스키마·코드·마스터·과거 버전·복제·자산·HTML 출력 검사 |
| test/authoring-ui.test.js (신규) | 실제 UI 작성·실패 복구·CSS 복제·초안 보호·저장 지연 검사 |
| test/editor-foundation.test.js (신규) | 실제 드래그/취소/선택/한 축 수정/입력 확정/Undo 검사 |
| test/settings.test.js | POSIX 0600 권한 검사를 Linux에서 유지하고 Windows ACL 환경만 제외 |

런타임 의존성이나 lockfile 변경은 없다. 기존 Node 및 Chrome/Chromium, 한글 폰트를 사용한다.

## 사용법

1. 자료를 열고 **HTML/CSS**를 누른다. 현재 슬라이드 내부 HTML과 추가 CSS를 편집하거나 표지·제목과 본문·2단 비교 구성을 생성한 뒤 **검증하고 적용**한다.
2. **JSON**에서는 전체 편집 상태를 수정한다. 추가 개체, 좌표, patch, 코드와 마스터 연결을 편집할 수 있다. 지원하지 않는 필드나 미래 schemaVersion은 오류로 표시된다.
3. **마스터**에서 이름·공통 HTML/CSS를 작성하고 현재 슬라이드 또는 전체 슬라이드에 연결한다. 연결된 마스터 수정은 모든 연결 슬라이드에 적용된다.
4. 슬라이드를 복제하면 코드 ID·해당 patch·CSS의 정확한 data-sd-id 속성 선택자와 마스터 연결이 복제된다. 일반 class·문자열은 유지된다.
5. 실패한 입력은 수정창에 유지된다. 저장 실패 후 창을 닫아도 코드/JSON을 다시 열어 로컬 초안을 고칠 수 있다. 저장 충돌은 기존 충돌 복구 흐름으로 처리한다.
6. 원본 자산 파일은 덮어쓰지 않는다. **원본 ZIP**은 가져온 파일 그대로이며 **HTML 다운로드**에 현재 저장 버전의 코드·마스터가 반영된다.

HTML/CSS 적용은 해당 슬라이드의 원본·코드 개체 patch를 초기화한다. 별도로 추가한 글/이미지는 유지된다. 적용 전 안내문을 표시하며 Undo와 과거 버전으로 되돌릴 수 있다.

## 지원 범위

- HTML은 슬라이드 내부 구성이다. 문서 전체 html/head/body나 JS 편집기는 아니다. 기존 원본의 전역 CSS 파일은 유지되고, 입력한 CSS가 선택 슬라이드에 추가된다.
- 신규 코드는 일반 제목·문단·컨테이너·표·이미지 등을 지원한다. script, 이벤트 속성, iframe, 편집기 예약 마크업, 외부 URL/가져오기는 허용하지 않는다. 이미지 경로는 자료 안의 실제 자산 경로를 사용한다.
- CSS 범위는 @scope를 사용한다. 스테이징과 실제 출력용 Chromium에서 지원 여부와 외형을 확인한다. 기존 가져온 문서의 스크립트 격리 정책은 그대로 유지한다.
- 마스터는 공통 HTML/CSS 장식 레이어이다. 개별 마스터 항목의 캔버스 드래그 편집, PowerPoint 자리 표시자 상속, 테마 글꼴 엔진, PPTX native 마스터 변환은 아직 지원하지 않는다.
- PPTX에서는 코드로 만든 지원 텍스트/이미지가 기존 편집형 경로를 사용한다. 마스터 장식은 배경 이미지에 포함되며 PPTX에서 마스터로 다시 편집되지 않는다.
- 원본 HTML의 상대 translate 좌표 의미는 유지했다. 모든 개체를 절대 좌표로 재작성하지 않았다.

## 새 상태와 과거 자료

schemaVersion이 없는 과거 상태는 읽을 때 version 1로 변환하고, slideCode / masters / slideMasters를 빈 객체로 보완한다. 과거 revision 파일은 수정하지 않는다. 이후 저장하면 정규화한 상태가 새 revision에 기록된다.

새 최상위 필드나 알 수 없는 미래 버전은 조용히 삭제하지 않고 거절한다. 운영 공유본에 자체 확장한 상태 필드가 있다면 해당 필드를 먼저 새 스키마에 통합해야 한다.

저장 전에 state 전체를 검증하며, 코드/마스터의 실제 자산 존재는 저장 단계에서 확인한다. validate API는 상태 검증·정규화만 수행하고 파일을 기록하지 않는다.

## 적용 전 준비

아래 경로와 서비스명은 실제 서버 값으로 지정해야 한다. 기존 운영 경로를 그대로 추측해서 사용하지 않는다.

1. 실제 코드의 Git 상태와 자체 변경을 확인하고 별도 브랜치/스테이징에서 패치를 대조한다.
2. 현재 코드, 환경 설정, DATA_DIR 전체(자산·meta·모든 revision·인증 파일)를 함께 백업한다. 일관된 백업을 위해 해당 앱의 쓰기를 중단하거나 앱 프로세스를 잠시 정지한다.
3. 백업·검증용 복사본을 운영 DATA_DIR과 분리한다. 테스트는 자체 임시 디렉터리를 사용한다.
4. 인증 파일·환경 파일·개인 발표 자료를 Git이나 공유 ZIP에 포함하지 않는다.

```bash
# 실제 코드 체크아웃과 전달받은 패치의 경로로 변경
APP_DIR=/actual/path/to/web-slides-studio
PATCH_FILE=/actual/path/to/stage0-handoff/changes.patch
cd "$APP_DIR"
git status --short
git rev-parse HEAD

# 실제 코드가 기준 공유본과 다르면 먼저 충돌과 운영 변경을 검토
git apply --check "$PATCH_FILE"
git apply "$PATCH_FILE"
git diff --check
```

git apply --check가 실패하면 전체 파일을 강제로 덮어쓰지 않는다. 실패한 hunk와 운영 자체 변경을 병합한 뒤 같은 검증을 반복한다. 패치와 changed-files/는 같은 변경의 두 표현이며 둘을 중복 적용하지 않는다.

## Linux 자동 검증

```bash
cd "$APP_DIR"
npm ci --no-audit --no-fund

# 실제 설치된 실행 파일을 지정
export CHROME_PATH=/usr/bin/chromium
test -x "$CHROME_PATH"
node --version
"$CHROME_PATH" --version

node --test test/authoring.test.js test/editor-foundation.test.js test/authoring-ui.test.js
npm test
git diff --check
```

기존 테스트의 Linux 파일 권한 0600 검사는 계속 실행된다. 한글 폰트를 설치한 환경에서 출력 테스트를 수행한다. 실제 PowerPoint 재열기·외형 비교와 OS 한글 IME는 자동 테스트와 별도로 아래 항목을 확인한다.

## 별도 스테이징 실행

현재 운영 DATA_DIR을 직접 지정하지 말고 백업의 복사본 또는 새로운 비공개 디렉터리를 지정한다. 기존 프로세스와 같은 데이터에 두 프로세스를 동시에 붙이지 않는다.

```bash
# 코드 적용과 npm ci를 완료한 스테이징 경로에서 실행
STAGING_DATA=/actual/private/path/studio-stage0-data
HOST=127.0.0.1 \
PORT=14310 CONTENT_PORT=14311 \
APP_ORIGIN=http://127.0.0.1:14310 \
CONTENT_ORIGIN=http://127.0.0.1:14311 \
DATA_DIR="$STAGING_DATA" \
CHROME_PATH=/usr/bin/chromium \
node src/server.js
```

원격 접속이면 두 포트를 로컬로 전달하여 브라우저에서 확인한다. 기존 인증 데이터 복사본을 사용한 경우 기존 암호가 적용된다. 운영용 HTTPS 관리/콘텐츠 origin은 계속 분리해야 한다.

## 수동 합격 기준

- 새 텍스트 초기 x=150,y=160에서 오른쪽 10 이동 → x=160,y=160. y만 바꿔도 x 유지. 저장·새로고침 후 동일.
- 미세 드래그, Escape, pointercancel 후 DOM과 저장 위치가 일치. 한 드래그는 한 번 Undo.
- 빈 공간 클릭·다른 슬라이드 이동 후 선택 패널이 해제되고 이전 개체가 수정되지 않음.
- 더블클릭으로 한글을 입력하고 즉시 Undo, JSON 열기, 슬라이드 이동. 마지막 음절 유실 없음.
- OS IME로 받침 수정·한/영 전환·조합 중 Esc/Backspace/Enter·포커스 이동을 시험한다. 자동 테스트는 브라우저 합성 composition 이벤트 검사이다.
- HTML/CSS를 적용하고 직접 개체 수정·복제·Undo·저장·재열기·버전 복원.
- 없는 이미지 경로로 저장을 실패시킨 뒤 창을 닫고 다시 열어 수정 가능.
- JSON에 알 수 없는 필드를 넣으면 오류와 초안이 유지되고, 고치면 저장 가능.
- 마스터를 두 장에 연결하고 공통 문구 변경, 한 장 연결 해제, 마스터 변경 Undo.
- 마스터 작성 도중 선택을 바꾸고 폐기 확인을 취소하면 초안 유지.
- HTML ZIP, PDF, 편집형 PPTX 생성. PDF의 마스터 표시와 PPTX의 코드 텍스트 편집성 확인.
- 실제 PowerPoint에서 파일 복구 경고·한글 폰트·줄바꿈·겹침·배치를 비교.
- 두 편집 창의 revision 충돌 시 내 변경 보존, 게시 revision 고정, 과거 버전 복원.
- 출력 도중/저장 지연 중 후속 편집이 덮이지 않는지 확인.

## 운영 반영

검증한 코드 묶음을 기존 배포 방식으로 반영한다. Node 서비스면 실제 서비스 단위만 재시작하고, Docker 운영이면 현재 사용하는 Compose 설정의 해당 서비스 이미지를 다시 빌드·교체한다. 예제 compose 파일을 실제 운영 설정으로 임의 대체하지 않는다.

변경된 파일에는 새 public/authoring-ui.js와 src/authoring.js가 포함되어야 한다. 일부 JS만 교체하면 UI/서버 계약이 맞지 않으므로 함께 배포한다. 기존 Dockerfile은 public/src 폴더 전체를 복사하므로 두 파일도 포함한다.

재시작 후 로그인, health, 이전 자료 열기, 새 코드 저장, 마스터 연결, HTML/PDF/PPTX 다운로드를 점검한다. 재시작하면 메모리 세션은 초기화되므로 재로그인이 필요하다.

## 되돌리기

새 상태를 저장한 뒤 예전 코드만 되돌려서 계속 편집하면 옛 validator가 코드·마스터 필드를 삭제할 수 있다. 따라서 다음 중 하나를 선택한다.

- 새 코드 안의 Undo/버전 복원으로 문서 변경만 되돌린다.
- 배포 전체를 되돌려야 하면 앱을 중지하고 적용 전 코드·설정·DATA_DIR 백업을 함께 복구한다. 새 버전에서 작성한 자료는 별도 보관한다.

운영 데이터 디렉터리를 삭제하거나 일괄 덮어쓰는 자동 롤백 스크립트는 제공하지 않는다. 실제 경로와 보존할 최신 변경을 확인한 뒤 기존 배포 절차로 복구한다.

## 검증 기록

수정 전: Windows 실제 Chrome에서 기존 21개 중 20개 통과, 실패 1개는 POSIX 권한을 Windows에서 비교하던 테스트였다. Linux 검사는 유지했다.

수정 과정: 좌표/선택/직접 입력 Undo와 코드 UI 신규 테스트 실패를 먼저 확인했다. 독립 리뷰의 저장 실패 복구, CSS ID 참조 복제, 마스터 초안 유실도 재현 후 수정했다.

최종 Windows/Chrome 전체 테스트는 47개 통과, 실패·건너뛰기 0개다. 새 코드/마스터가 있는 자료로 HTML ZIP, PDF 1페이지, 편집형 PPTX의 제목 텍스트 생성을 확인했다. 독립 리뷰의 3건과 CSS 치환 경계 사례를 수정하고 재검토했다. 패치 검증 결과는 전달 묶음의 VERIFICATION.txt를 함께 확인한다. Linux 운영 서버·실제 PowerPoint 프로그램·OS 한글 IME 전체를 이번 Windows 환경에서 검증했다고 주장하지 않는다.
