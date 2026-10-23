# AI로 편집 가능한 웹 발표 만들기

Web Slides Studio는 AI가 만든 HTML ZIP을 가져와 글·이미지·배치를 수정하고 발표하는 도구입니다. **Codex·Claude Code용 작성 스킬**과 **Studio를 읽고 수정하는 MCP 연결**은 별개입니다. 스킬만으로 파일을 만들 수 있으며, MCP까지 연결하면 허용된 ZIP을 자료실에 가져오고 기존 자료를 수정할 수 있습니다.

## 복사해서 사용하는 프롬프트

아래 대괄호를 채워 AI에 전달하세요. 스킬을 설치했다면 Codex에서는 `$web-slides-author`, Claude Code에서는 `/web-slides-author`를 앞에 붙여도 됩니다.

```text
Web Slides Studio에서 가져와 편집할 HTML 발표 자료를 실제 파일과 ZIP으로 만들어 주세요.
주제: [주제] / 청중: [청중] / 발표 길이: [분 또는 장수]
자료: [본문·첨부·출처] / 원하는 분위기: [선택]

작성자 → 디자이너 → 검수자 순서로 작업하세요. 장별 핵심 메시지를 정리하고,
제공 자료에 없는 사실은 확인하거나 가정으로 표시하세요.

16:9, 1920×1080의 main#stage 안에 같은 부모를 둔 section.slide를 만드세요.
한 번에 한 장만 표시하고, 글은 수정 가능한 DOM 텍스트로 남겨 주세요.
index.html과 상대 경로의 CSS·JS·이미지·글꼴을 ZIP에 함께 넣으세요.
외부 CDN·API·fetch·iframe·worker에 의존하지 마세요.

Three.js는 설명에 도움이 될 때만 쓰고 로컬 .js 라이브러리로 묶으세요.
기본 도형·절차적 그래픽을 사용하고 .gltf/.glb/.bin 모델은 넣지 마세요.
장식 canvas는 글 뒤에 두고 pointer-events:none을 적용하세요.
WebGL 실패·동작 줄이기 설정에서도 읽을 수 있는 정지 대안을 제공하세요.
Studio의 키보드·발표 이동과 충돌하지 않게 하고 Tab을 전역 차단하지 마세요.

ZIP 40 MiB, 압축 해제 64 MiB, 300파일, 1~80장 이내로 준비하세요.
모든 장의 잘림·자산 누락·한글·이동·링크를 확인하세요.
가능하면 Studio에 가져온 뒤 글 수정→저장→새로고침까지 검증하세요.
MCP로 기존 자료를 수정할 때는 현재 상태와 revision을 읽고 충돌 시 다시 확인하세요.
HTML/CSS 편집창에는 슬라이드 내부 HTML/CSS만 넣고 JS·canvas를 붙이지 마세요.
PDF는 이미지이며, 편집 가능 PPTX도 3D·복잡한 CSS는 배경 이미지임을 알려 주세요.
완료하면 ZIP/원본 파일 또는 편집 링크와 실제 검사 결과·미확인 항목을 주세요.
```

장수·시각 효과는 내용에 맞춰 정합니다. 모든 장에 3D나 차트를 넣을 필요는 없습니다. 비공개 자료·암호는 프롬프트나 발표자 노트에 넣지 마세요. 노트는 공유·HTML·PPTX에 포함됩니다.

## Codex·Claude Code 연결

Node.js 20.19 이상(22 LTS 권장)과 사용할 클라이언트 CLI가 필요합니다. 저장소를 유지할 위치에 둔 뒤 해당 폴더에서 실행하세요. MCP가 이 경로의 파일을 실행하므로 설치 후 저장소를 옮기면 다시 연결해야 합니다.

```bash
npm ci
npm ci --prefix integrations/mcp
node scripts/install-ai.mjs --client codex --url http://127.0.0.1:4310
```

Claude Code는 `--client claude`, 두 클라이언트는 `--client all`입니다. `all`은 설치된 CLI를 확인합니다. 이 명령은 Studio 서버 자체를 시작하지 않습니다. 로컬 서버 실행은 [README](../README.md)를 따르세요.

원격 서버 또는 ZIP 자동 가져오기를 쓸 때는 다음처럼 설정합니다. 예시 경로를 본인 환경으로 바꾸세요.

```bash
node scripts/install-ai.mjs --client all \
  --url https://slides.example.com \
  --password-file /absolute/private/studio-password.txt \
  --workspace /absolute/deck-workspace
```

암호 파일과 workspace 폴더는 실행 전에 준비합니다. 암호 파일은 사용자가 직접 비공개 위치에 두고 본인만 읽을 수 있게 제한합니다. 파일에는 Studio 로그인 암호를 넣습니다. 설치기는 암호값 대신 파일 경로를 등록합니다. `--workspace`는 AI가 읽어 가져올 ZIP의 허용 루트이며, 생략하면 ZIP 가져오기 도구를 사용할 수 없습니다. 해당 폴더 안의 일반 `.zip`만 허용하고 심볼릭 링크는 거부합니다. 인증된 서버에는 암호 설정이 필요하며 원격 주소는 HTTPS를 사용합니다.

스킬은 Codex의 `~/.agents/skills/web-slides-author`, Claude Code의 `~/.claude/skills/web-slides-author`에 설치됩니다. MCP는 `web-slides-studio`라는 이름으로 등록됩니다. 기존 설정이 충돌하면 안내를 확인하고, 이 스킬과 MCP 등록을 의도적으로 교체할 때만 `--replace`를 사용하세요. 연결 후 새 세션에서 스킬과 MCP 도구가 보이는지 확인합니다. 클라이언트의 도구 권한은 해당 클라이언트 설정을 따릅니다.

MCP 없이 쓰려면 저장소의 [skills/web-slides-author](../skills/web-slides-author/SKILL.md) 폴더 전체를 원하는 클라이언트의 위 스킬 경로에 복사하세요. 생성한 ZIP은 자료실의 **HTML ZIP 올리기**로 직접 가져옵니다.

### 연결 확인과 기존 자료 수정

AI에 “Web Slides Studio 자료 목록을 읽어 주세요”라고 요청해 `slides_list_decks` 연결을 확인합니다. 기존 자료는 `slides_get_deck`로 현재 `revision`, `state`, 슬라이드 ID를 읽습니다. 한 장의 코드를 바꿀 때는 `slides_get_slide_source` 다음 `slides_update_slide`를 사용합니다. 전체 상태를 바꿀 때만 `slides_update_state`를 사용하고 다른 장·노트·마스터를 유지합니다.

저장 도중 다른 창이 수정하면 `revision_conflict`로 거부합니다. AI는 최신 상태를 다시 읽고 변경을 합쳐야 합니다. 새 revision 숫자만 바꾸어 기존 내용을 덮어쓰면 안 됩니다. `slides_import_bundle`은 ZIP을 **새 자료**로 가져오며 기존 자료의 원본 JS를 교체하지 않습니다. 이 MCP에는 공유 게시·삭제 도구가 없습니다.

MCP 환경변수는 `SLIDES_STUDIO_URL`, `SLIDES_STUDIO_PASSWORD_FILE`(우선) 또는 `SLIDES_STUDIO_PASSWORD`, `SLIDES_STUDIO_WORKSPACE`입니다. 암호값을 공개 설정 파일이나 대화에 기록하지 마세요. 자세한 도구 인자는 [스킬 런타임 안내](../skills/web-slides-author/references/runtime.md#connected-mcp-tools)에 있습니다.

## HTML과 Three.js 작성 범위

| 작업 | 지원 방법과 경계 |
| --- | --- |
| 새 HTML/Three.js 발표 | 원본 HTML ZIP에 로컬 JS와 자산 포함. 런타임에서 실행 |
| 한 장의 HTML/CSS 수정 | 슬라이드 내부 HTML/CSS만 전달. JS·canvas·이벤트 속성·iframe·외부 자산·SVG 마크업은 거부 |
| Three.js 라이브러리 | 로컬 `.js`와 상대 모듈 경로 또는 브라우저 번들 사용. 라이선스 고지 유지 |
| 3D 장면 | 기본 도형·절차적 그래픽 권장. `.gltf`, `.glb`, `.bin`, `.mjs`는 가져오기 미지원 |
| 데이터 읽기 | `.json`은 포함 가능하지만 `fetch`/XHR/WebSocket은 로컬·외부 모두 차단. 필요한 값은 로컬 JS에 포함 |
| 글·수치·출처 | HTML 텍스트로 작성. canvas에 그린 글은 텍스트 편집 불가 |
| 다운로드 | HTML은 웹 동작 유지. PDF·외형 보존 PPTX는 이미지. 편집 가능 PPTX의 복잡한 CSS·3D도 이미지 |

장식 canvas는 `#bg` 또는 `canvas[data-background]`로 표시하면 배경 표시 설정에 연결할 수 있습니다. `data-scene`은 장면 이름일 뿐이며 원본 코드가 그 이름에 대응하는 렌더링을 구현해야 합니다. Studio가 임의 3D 모델·카메라를 만들어 주거나 시각 편집하는 기능은 없습니다. 스크립트를 실행하지 않는 썸네일에는 3D가 보이지 않을 수 있습니다.

`#stage`는 1920×1080, `position:relative; transform-origin:0 0`으로 준비하고 `.slide`는 절대 배치합니다. `.slide.active` 한 장만 표시하세요. Studio는 활성 장과 배율을 제어합니다. 별도 원본 이동 버튼을 만든다면 `#sd-config`가 있는 Studio 실행에서는 자체 키보드 이벤트를 설치하지 않도록 하세요. 전역 Tab 차단과 양수 `tabindex`는 사용하지 않습니다.

ES module을 쓴 다운로드는 `index.html` 더블클릭 대신 압축을 푼 폴더에서 로컬 HTTP 서버로 확인합니다.

```bash
python3 -m http.server 8000 --bind 127.0.0.1
```

브라우저에서 `http://127.0.0.1:8000`을 엽니다. 원본이 독립 실행에서 정상이어도 Studio의 자산·네트워크 정책에 맞는지 가져온 뒤 확인해야 합니다. WebGL 실패 시 정지 이미지/CSS 대안을 두고, 동작 줄이기 설정에서는 애니메이션을 멈춥니다. 출력 시점에 의미 있는 정지 화면이 나오는지도 확인하세요.

## 역할별 작성 스킬

이 저장소의 스킬은 **작성자 → 디자이너 → 검수자** 책임을 한 흐름으로 묶습니다. 작성자는 메시지·근거, 디자이너는 읽기 쉬운 화면과 편집 가능한 구조, 검수자는 가져오기·저장·발표·출력 증거를 담당합니다. 별도 에이전트 세 개나 추가 모델 구독이 필수인 방식은 아닙니다.

역할과 산출물을 명확히 구분하는 구성은 [agency-agents](https://github.com/msitarzewski/agency-agents)를 참고했습니다. 해당 저장소의 에이전트나 인격 지침을 그대로 복사하지 않았으며, Web Slides Studio의 실제 제약에 맞춰 작성했습니다. Codex와 Claude Code에 같은 스킬 폴더를 사용할 수 있지만 도구 연결과 권한 관리는 각 클라이언트에서 따로 설정합니다.

공식 참고 문서: [Codex Skills](https://developers.openai.com/codex/skills/), [Codex MCP](https://developers.openai.com/codex/mcp/), [Claude Code Skills](https://code.claude.com/docs/en/skills), [Claude Code MCP](https://code.claude.com/docs/en/mcp).
