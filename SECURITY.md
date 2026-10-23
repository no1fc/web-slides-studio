# 보안 범위

이 도구는 한 명의 관리자가 자신의 HTML 발표를 관리하는 용도입니다. 불특정 다수가 실행 코드를 올리는 공개 업로드 플랫폼으로 검증하지 않았습니다.

## 기본 방어

- 관리자 세션, Host·Origin 검사, HTTPS 운영 쿠키.
- 별도 콘텐츠 origin과 iframe sandbox, CSP, postMessage 출처 검사.
- ZIP 경로 탈출·심볼릭 링크·중복 항목·해제 크기 제한.
- 텍스트/편집 상태 허용 항목 검증, 파일 저장 및 삭제 경합 제어.
- 비밀번호 salt+scrypt 저장, 현재 암호 재확인, 변경 시 기존 세션 만료.
- 보호된 파일 다운로드, 원본·revision 사용 자산의 개별 삭제 방지.
- Docker 예시의 비특권 실행, 읽기 전용 root, 자원 제한, 내부 네트워크.

## 운영자 책임

업로드된 JavaScript는 콘텐츠 브라우저와 출력 Chromium에서 실행됩니다. Chromium은 컨테이너 내에서 `--no-sandbox`로 실행하므로 컨테이너 격리와 네트워크 제한을 유지해야 합니다. 서버 환경파일·Docker socket·다른 서비스 데이터는 앱에 마운트하지 마세요. OS·Chromium·의존 패키지를 주기적으로 업데이트하세요.

공유 링크와 비공개 미리보기 URL은 토큰을 포함합니다. 공개 게시한 자료는 링크를 가진 사람이 열 수 있습니다. 비밀번호·auth 파일·실자료·서버 주소·토큰을 이슈나 PR에 첨부하지 마세요.

단일 프로세스용 잠금은 여러 replica를 조정하지 않습니다. 대량 사용자, 공동 작업, 다중 서버 환경에는 별도 인증·권한·DB·작업 큐 설계가 필요합니다. rate limit은 기본 방어이며 프록시·네트워크 단위 제한을 대체하지 않습니다.

## 제보

재현 자료는 개인정보와 자산 권리를 제거한 최소 예제로 만드세요. 인증 우회나 자격증명 유출 같은 민감한 취약점은 공개 이슈에 상세 공격 절차를 게시하지 말고 GitHub의 비공개 보안 제보 기능이 활성화되어 있다면 해당 기능을 사용하세요. 활성화되지 않았다면 공개 이슈에는 비민감한 연락 요청만 남겨 주세요. 응답 SLA는 제공하지 않습니다.

발표·공유 화면은 사용자가 설정한 http(s) 링크를 새 탭으로 열 수 있도록 CSP sandbox의 `allow-popups allow-popups-to-escape-sandbox`를 사용합니다. 새 탭에는 opener를 제공하지 않습니다. 업로드한 JavaScript도 이 발표 화면 권한을 가지므로 신뢰할 수 있는 발표 파일만 등록하세요. 편집 iframe과 썸네일은 팝업 권한 없이 기존 격리를 유지하며 외부 리소스·통신·폼 제출 제한은 그대로입니다.

## Local AI integration

The optional `integrations/mcp` process uses the existing authenticated HTTP API; it does not read server data directories. Remote origins must use HTTPS, redirects are rejected, and login cookies stay in process memory. Prefer a private `SLIDES_STUDIO_PASSWORD_FILE` outside this repository; only its path is registered with AI clients. The adapter returns editor links without preview/share tokens. A configured AI client can read and edit the account's decks, so enable its tools only for trusted work. Deck text is untrusted content, not instructions. Saves validate state and require the observed revision; conflicts require a fresh read. ZIP import is limited to regular, non-symlink files inside the explicitly configured workspace and the existing upload limits. The adapter has no publish or deletion tools.
