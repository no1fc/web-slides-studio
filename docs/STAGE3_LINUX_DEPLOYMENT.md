# 3단계: 텍스트 편집을 포함한 Linux 업데이트

이 업데이트는 기존 HTML/CSS·JSON·마스터(0단계), 정밀 조작·배율(1단계), 다중 선택·개체 배치·레이어(2단계)에 문자·문단·텍스트 상자 편집을 추가합니다. 공개 저장소의 통합 `main`을 기준으로 업데이트하며 실제 Linux 운영 서버 반영은 관리자가 수행합니다. 이전 단계의 패치 파일을 통합 소스에 다시 적용하지 않습니다.

이 문서는 배포·확인 절차와 개발 PC 검증 기록입니다. 실제 운영 서버의 배포나 Linux·PowerPoint 수동 검증을 완료했다는 기록이 아닙니다. 서버 반영 시 아래 표에 해당 환경의 결과를 추가합니다.

## 포함 기능과 출력 범위

- 개체 전체 또는 더블클릭 후 드래그한 문자 범위의 글꼴·크기·색·굵게·기울임·밑줄.
- 왼쪽·가운데·오른쪽·양쪽 문단 정렬, 줄간격 배수, 문단 뒤 간격, 0~8단계 들여쓰기, 글머리표·번호.
- 위·가운데·아래 세로 정렬, 넘침 표시·자르기, 최소 표시 글자 크기 6px까지 자동 축소.
- 한글 조합 확정 후 명령 처리, 외부 텍스트의 평문 붙여넣기, 서식 명령 한 번에 Undo 한 번.
- 문자·문단·상자 서식의 저장·새로고침·개체/슬라이드/자료 복제·버전 복원·HTML 출력 보존.
- 편집형 PPTX의 문자별 서식·문단·목록 기록과 자동 축소 표시 크기 반영.

문자 선택 없이 커서만 있으면 문자 서식은 전체 문자에, 문단 서식은 현재 문단에 적용합니다. 개체만 선택하면 모든 문자·문단에 적용합니다. 상자 설정은 항상 개체 전체에 적용합니다. 사용 방법은 [사용 안내](USER_GUIDE.md#텍스트-전체부분-서식과-문단), `richText`·`textBox` JSON 예시는 [구조 문서](ARCHITECTURE.md#구조화된-텍스트)에 있습니다.

자동 맞춤은 JSON의 논리 글자 크기·문단 간격·들여쓰기를 변경하지 않습니다. 화면에서는 이 값을 함께 줄이고 편집형 PPTX에는 실제 표시된 크기를 기록합니다. 6px에서도 맞지 않는 내용은 넘침을 안내합니다. ‘자르기’에서 실제로 넘치는 글자는 화면 보존을 위해 PPTX 배경 이미지에 포함하므로 해당 글자는 PowerPoint에서 개별 편집할 수 없습니다.

이미지·표·다른 편집 ID를 포함한 복합 컨테이너는 안쪽의 편집 가능한 텍스트 개체를 선택해야 합니다. 임의 HTML의 고급 장식을 모두 구조화하지는 않습니다. 기존 코드·마스터·배치·레이어 기능은 유지합니다. PDF와 외형 보존 PPTX는 이미지이며, 실제 PowerPoint에서의 글꼴·줄바꿈·외형 동등성은 별도 확인 대상입니다.

## 적용 전 확인과 백업

1. 현재 코드 경로·브랜치·커밋·자체 변경, Node 서비스 또는 Compose 구성, 환경 파일과 `DATA_DIR` 마운트를 확인합니다.
2. 쓰기를 중단한 일관된 시점에 코드·환경 설정·`DATA_DIR` 전체를 함께 백업합니다. 자산·메타데이터·모든 revision·`_auth.json`이 필요합니다.
3. 운영 경로와 분리한 백업에서 복원 가능 여부를 확인합니다. 환경 파일·인증정보·발표 자료를 저장소나 공개 이미지에 넣지 않습니다.
4. 스테이징 코드와 데이터 복사본을 별도 준비합니다. 운영 데이터 경로에 두 앱 프로세스를 동시에 연결하지 않습니다.

```bash
# 현재 운영 체크아웃에서 읽기 확인. 실제 경로로 바꿉니다.
APP_DIR=/path/to/current/web-slides-studio
cd "$APP_DIR"
git status --short --branch
git rev-parse HEAD
```

다음 예제의 경로·서비스명은 현재 운영 환경을 확인한 뒤 사용합니다. 자체 수정이 있으면 먼저 보존하고 업데이트와 병합합니다.

## 스테이징 소스와 실행 환경

깨끗한 스테이징 체크아웃의 `main`을 업데이트합니다. 이미 체크아웃이 있으면 복제 명령은 생략합니다.

```bash
STAGING_DIR=/path/to/staging/web-slides-studio
git clone https://github.com/no1fc/web-slides-studio.git "$STAGING_DIR"
cd "$STAGING_DIR"
git status --short --branch
git switch main
git pull --ff-only origin main
git rev-parse HEAD
npm ci --ignore-scripts
```

`git pull --ff-only`가 실패하면 자체 커밋·로컬 변경과 새 소스의 차이를 확인하고 별도 브랜치에서 병합·검증합니다. 강제 초기화나 전체 덮어쓰기로 자체 변경을 버리지 않습니다.

Node.js 22를 권장하며 소스 지원 범위는 Node.js 20 이상입니다. PDF/PPTX와 브라우저 테스트에는 Chrome 또는 Chromium, 한글 글꼴이 필요합니다. 저장소 Dockerfile은 Node 22·Chromium·Noto CJK 글꼴을 포함합니다. 호스트에서 직접 실행하거나 자체 이미지를 사용하면 같은 구성요소를 준비합니다. Debian/Ubuntu 계열의 패키지 설치 예시는 다음과 같습니다.

```bash
sudo apt-get update
sudo apt-get install -y chromium fonts-noto-cjk fontconfig ca-certificates

# 실제 설치 경로로 지정합니다. Chrome을 쓰면 해당 실행 파일 경로를 사용합니다.
export CHROME_PATH=/usr/bin/chromium
test -x "$CHROME_PATH"
node --version
"$CHROME_PATH" --version
fc-match 'Noto Sans CJK KR'
```

배포판의 Chromium 패키지·실행 방식은 환경마다 다를 수 있습니다. 패키지 설치 성공뿐 아니라 위 실행 파일로 브라우저 테스트·출력이 동작하는지 확인합니다. 사용한 글꼴이 없으면 다른 글꼴로 대체될 수 있으므로 실제 자료의 한글과 줄바꿈도 확인하세요. 웹 글꼴을 쓰는 자료는 해당 로컬 글꼴 자산을 함께 포함해야 합니다. PPTX에는 글꼴 파일을 삽입하지 않으므로 PowerPoint PC의 설치 글꼴도 별도로 맞춥니다.

## 자동 검증

```bash
# CHROME_PATH를 지정한 스테이징 체크아웃에서 실행합니다.
npm test
node --test test/text-model.test.js test/text-ui.test.js test/text-browser.test.js test/text-export.test.js test/export.test.js
git diff --check
```

전체 테스트가 기존 코드·마스터·저장·보안·배치 회귀를 검사하고, 텍스트 테스트가 선택 범위·IME 확정 처리·자동 맞춤·구조화 상태·출력을 집중 검사합니다. `npm test`는 여러 Chromium 프로세스의 자원 경합을 줄이기 위해 테스트 파일 동시 실행을 2개로 제한합니다. 테스트 자료는 임시 디렉터리에 자체 생성합니다. 운영 데이터 복사본의 검증과 OS 한글 IME 수동 검증은 별도로 진행합니다.

PPTX 자동 검증은 XML의 run·문단 속성, 목록, 간격, 축소 표시값과 잘린 텍스트의 배경 보존을 확인합니다. 이 결과가 실제 PowerPoint의 렌더링 일치를 뜻하지는 않습니다.

## 스테이징 실행과 수동 확인

운영 데이터 복사본 또는 새 비공개 데이터 경로를 사용합니다. 아래는 loopback 바인딩 예시입니다.

```bash
STAGING_DATA=/path/to/private/studio-staging-data
HOST=127.0.0.1 \
PORT=14310 CONTENT_PORT=14311 \
APP_ORIGIN=http://127.0.0.1:14310 \
CONTENT_ORIGIN=http://127.0.0.1:14311 \
DATA_DIR="$STAGING_DATA" \
CHROME_PATH="$CHROME_PATH" \
node src/server.js
```

원격 서버는 관리·콘텐츠 두 포트를 로컬로 전달해 확인합니다. 복사한 `_auth.json`이 있으면 백업 시점의 암호를 사용합니다. 운영 공개에서는 기존의 서로 다른 HTTPS 관리·콘텐츠 origin, 인증, 렌더러 네트워크 격리를 유지합니다. 세부 환경변수는 [운영 안내](OPERATIONS.md)를 참고하세요.

| 확인 항목 | 합격 기준 |
| --- | --- |
| 기존 자료·코드·마스터 | 기존 평문 자료와 HTML/CSS·JSON·공통 마스터가 열리고 저장·버전 복원이 동작 |
| 전체·부분 문자 | 전체 서식 후 특정 한글·영문·emoji 범위만 색·크기·굵게·기울임·밑줄 변경, 도구 포커스 이동 뒤 범위 유지 |
| 커서와 문단 | 커서만 있을 때 문자 명령은 전체 문자, 문단 명령은 현재 문단에 적용. 복수 문단 범위에서는 해당 문단에만 적용 |
| 간격·목록 | 줄간격·문단 뒤 간격·들여쓰기·양쪽 정렬·글머리표·번호가 저장 후 유지 |
| 상자·자동 맞춤 | 위/가운데/아래 정렬, 표시/자르기 전환, 축소 후 JSON 원래 크기 유지, 6px에서도 안 맞는 경우 넘침 안내 |
| 한글·붙여넣기 | 실제 OS IME 조합 중 서식·저장·포커스 이동 후 최종 글자가 남고, 외부 서식 있는 글을 붙여넣으면 평문만 삽입 |
| 이력·복제 | 서식 한 번 Undo, 다시 실행, 새로고침, 개체·슬라이드 복제와 이전 버전 복원 시 내용·서식 보존 및 사본 독립성 |
| 지원 경계 | 잠긴 개체·다중 선택·이미지/표가 섞인 컨테이너의 텍스트 도구 비활성화, 안쪽 텍스트 선택 후 편집 가능 |
| 기존 조작 | 50/100/200% 배율, 이동·크기·회전·다중 배치·레이어·복제 동작 유지 |
| HTML·PDF·PPTX | HTML ZIP을 풀어 실행하고 서식 확인, Linux 출력의 한글·여백·잘림 확인, 실제 PowerPoint에서 파일 열기·문자 편집·재저장·재열기 |
| 저장·공유 | 두 창의 저장 충돌 처리, 게시한 버전 고정과 공유 종료 동작 유지 |

## 운영 반영

스테이징에서 검증한 커밋 또는 자체 변경을 병합해 검증한 커밋을 배포합니다. 운영 체크아웃이 깨끗한 `main`이고 원격 이력으로 fast-forward할 수 있으면 다음처럼 갱신합니다. 최종 SHA가 검증한 커밋과 같은지 확인하고, 원격에 추가 변경이 있으면 해당 변경까지 검증한 뒤 반영합니다.

```bash
cd "$APP_DIR"
git status --short --branch
git switch main
git pull --ff-only origin main
git rev-parse HEAD
npm ci --ignore-scripts
```

Node 직접 실행·서비스 방식은 기존 환경 파일과 데이터 경로를 유지하고 실제 앱 서비스만 재시작합니다. Compose는 현재 운영 파일·프로젝트·서비스를 확인한 후 해당 이미지를 빌드·교체합니다. 다음 예제의 서비스명과 경로는 실제 값으로 바꾸고 기존에 사용한 프로젝트명·환경 파일 옵션이 있다면 그대로 포함합니다.

```bash
COMPOSE_FILE=/path/to/your/compose.yml
STUDIO_SERVICE=studio

docker compose -f "$COMPOSE_FILE" build "$STUDIO_SERVICE"
docker compose -f "$COMPOSE_FILE" up -d --no-deps "$STUDIO_SERVICE"
docker compose -f "$COMPOSE_FILE" ps "$STUDIO_SERVICE"
docker compose -f "$COMPOSE_FILE" logs --tail 100 "$STUDIO_SERVICE"
```

`src`와 `public` 전체를 같은 커밋에서 반영합니다. 특히 **`public/text-model.js`, `public/text-editor.js` 두 새 파일**이 서버 이미지·배포 파일에 있어야 합니다. `src/text-export.js`와 변경된 `bridge.js`·`app.js`·HTML·CSS·서버도 함께 배포합니다. 일부 스크립트만 갱신하면 저장 스키마와 메시지 계약이 맞지 않을 수 있습니다. Dockerfile의 기존 `COPY src`·`COPY public`은 새 파일을 포함합니다.

재시작 후 브라우저 편집 페이지를 새로고침하고 재로그인합니다. 관리 origin에 맞는 Host로 `/health` 응답을 확인하고, 기존 자료 열기 → 부분 문자 서식 → 저장·새로고침 → HTML/PDF/편집형 PPTX 다운로드 순서로 간단히 점검합니다. 콘텐츠의 두 새 스크립트 요청이 404 없이 로드되는지도 확인합니다. 정상 확인 전에는 적용 전 백업과 기존 이미지를 유지합니다.

## 롤백과 상태 호환성

`schemaVersion`은 1이지만 새 revision에는 `richText`·`textBox`가 포함될 수 있습니다. 이전 validator는 이를 거절할 수 있으므로 새 데이터를 둔 채 코드만 이전 단계로 되돌리는 방식은 호환되는 롤백이 아닙니다.

자료 편집만 되돌리려면 새 코드의 Undo 또는 버전 복원을 사용합니다. 배포 전체를 되돌려야 하면 앱을 중지하고 현재 데이터도 별도로 보존한 다음 적용 전 코드·환경 설정·전체 데이터 백업을 함께 복구합니다. 새 버전에서 만든 편집은 예전 백업에 없고 인증정보도 백업 시점으로 돌아갈 수 있습니다. 복구 대상과 보존할 변경을 확인한 뒤 진행합니다.

## 검증 기록

2026-10-21 개발 PC에서 전체 테스트와 코드 검토를 완료했습니다. 제한 없이 병렬 실행한 중간 검증은 호스트 부하로 중단했고, 최종 `npm test`는 동시 실행 2개로 아래 결과를 확인했습니다. 개발 PC 자동 검증과 Linux 운영·PowerPoint 수동 검증을 구분해 기록합니다.

| 기록 항목 | 결과 |
| --- | --- |
| 검증한 Git 커밋 | 이 문서를 포함한 3단계 커밋. 배포 시 `git rev-parse HEAD`로 실제 SHA 기록 |
| 개발 검증 OS·Node·Chrome 버전 | Windows · Node.js 22.14.0 · Chrome 156.0.8078.47 |
| 전체 `npm test` 결과 | 143/143 통과, 실패·생략 0, 종료 코드 0 |
| 텍스트·출력 집중 테스트 결과 | 위 전체 결과에 포함. 문자 범위·빈 문단·IME 이벤트·축소 붙여넣기·키보드 이력·저장/복제·오프라인 HTML·PPTX XML 검증 |
| 화면·코드 검토 | 1600×1050, 1280×800 화면 확인; 브라우저 오류 0; 별도 코드 검토 후 재현 결함 수정 |
| Linux 배포판·Node·Chromium 버전 | 서버 적용 시 기록 |
| Linux 한글 글꼴·실제 출력 확인 | 서버 적용 시 확인 |
| OS 한글 IME 수동 확인 | 미실행. 자동 테스트는 composition 이벤트로 검증 |
| PowerPoint 버전·재열기·글꼴·줄바꿈 확인 | 실제 PowerPoint에서 별도 확인 필요 |
| 운영 반영 시각·반영 커밋·백업 위치 | 관리자가 배포 후 기록 |
