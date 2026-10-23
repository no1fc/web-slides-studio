"use strict";
(() => {
  const labels = { server: "서버 접속", authentication: "인증", tools: "도구 호출", workspace: "ZIP 작업 폴더" };
  const statuses = { ok: "확인됨", error: "문제 있음", unknown: "확인되지 않음" };
  const remedies = {
    server: "서버 주소와 인터넷 연결을 확인하세요.",
    authentication: "외부 PC의 비공개 암호 파일을 확인하세요. 암호를 AI 대화에 붙여 넣지 마세요.",
    tools: "연결 도구를 업데이트하고 AI 앱을 완전히 종료한 다음 다시 실행하세요.",
    workspace: "외부 PC에서 허용 작업 폴더가 있는지 확인하고 그 안의 ZIP 파일을 사용하세요.",
  };
  function commands(platform, client, update = false) {
    const origin = location.origin;
    const install = `node scripts/install-ai.mjs --client ${client} --url ${origin} --setup${update ? " --replace" : ""}`;
    if (platform === "windows") return [
      ...(update ? [] : ['git clone https://github.com/no1fc/web-slides-studio.git "$HOME\\sdlab-slides-ai"', 'if ($LASTEXITCODE -ne 0) { throw "저장소 준비 실패: 기존 폴더는 업데이트 명령을 사용하세요." }']),
      'Set-Location "$HOME\\sdlab-slides-ai" -ErrorAction Stop',
      ...(update ? ['git pull --ff-only', 'if ($LASTEXITCODE -ne 0) { throw "업데이트 실패: 로컬 변경을 확인하세요." }'] : []),
      'npm ci --prefix integrations/mcp --ignore-scripts', 'if ($LASTEXITCODE -ne 0) { throw "연결 도구 설치 실패" }', install,
    ].join("\n");
    return [
      ...(update ? [] : ['git clone https://github.com/no1fc/web-slides-studio.git "$HOME/sdlab-slides-ai"']),
      'cd "$HOME/sdlab-slides-ai"', ...(update ? ["git pull --ff-only"] : []),
      "npm ci --prefix integrations/mcp --ignore-scripts", install,
    ].join(" &&\n");
  }
  function older(version, minimum) {
    const a = String(version).split(".").map(Number), b = String(minimum).split(".").map(Number);
    if (a.length !== 3 || b.length !== 3 || a.some(n => !Number.isInteger(n))) return null;
    for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
    return false;
  }
  async function open() {
    const body = dialog("AI 연결");
    body.oninput = null;
    body.append(el("p", "이 웹사이트에 연결할 외부 PC에서 한 번만 설치하세요. 웹 서버나 Docker를 설치할 필요가 없습니다."));
    const choices = el("div", undefined, "actions");
    function select(label, id, options) {
      const wrapper = el("label", label + " "), node = el("select"); node.id = id;
      for (const [value, text] of options) { const option = el("option", text); option.value = value; node.append(option); }
      wrapper.append(node); choices.append(wrapper); return node;
    }
    const platform = select("외부 PC", "aiPlatform", [["windows", "Windows (PowerShell)"], ["macos", "macOS (터미널)"], ["linux", "Linux (터미널)"]]);
    const client = select("AI 앱", "aiClient", [["codex", "Codex"], ["claude", "Claude Code"]]);
    body.append(choices, el("p", "준비: Git, Node.js 20.19 이상, 선택한 AI 앱의 CLI. 아래 명령은 암호를 포함하지 않습니다. 설치 중 터미널에 직접 입력하는 암호는 표시되지 않으며 외부 PC의 비공개 파일에만 저장됩니다."));
    const commandLabel = el("label", "외부 PC 설치 명령"), command = el("textarea");
    command.id = "aiInstallCommand"; command.rows = 6; command.readOnly = true; command.spellcheck = false; command.style.width = "100%";
    commandLabel.append(command); body.append(commandLabel);
    const message = el("p", ""); message.setAttribute("role", "status");
    function copy(label, value) {
      const button = el("button", label);
      button.onclick = async () => { try { await navigator.clipboard.writeText(value()); message.textContent = "복사했습니다."; } catch { message.textContent = "복사 권한이 없습니다. 내용을 선택해 복사하세요."; } };
      return button;
    }
    body.append(copy("설치 명령 복사", () => command.value));
    const update = el("details"), summary = el("summary", "이미 설치했다면 업데이트");
    const updateCommand = el("textarea"); updateCommand.id = "aiUpdateCommand"; updateCommand.rows = 5; updateCommand.readOnly = true; updateCommand.style.width = "100%";
    updateCommand.setAttribute("aria-label", "외부 PC 업데이트 명령");
    update.append(summary, el("p", "기존 연결 등록을 같은 이름으로 갱신합니다. 설치 폴더를 옮겼다면 해당 위치에서 마지막 두 명령을 실행하세요."), updateCommand, copy("업데이트 명령 복사", () => updateCommand.value)); body.append(update);
    const prompt = el("textarea"); prompt.id = "aiConnectionPrompt"; prompt.readOnly = true; prompt.rows = 5; prompt.style.width = "100%";
    prompt.setAttribute("aria-label", "AI에 전달할 연결 확인 프롬프트");
    prompt.value = "Web Slides Studio의 slides_diagnose_connection 도구를 실행해 서버 접속, 인증, 도구 호출, ZIP 작업 폴더 결과와 MCP 버전을 확인해 주세요. 암호나 인증정보는 요청하거나 출력하지 마세요. 연결되면 자료 목록을 읽어 주세요. 기존 자료를 수정할 때는 현재 revision을 읽고 slides_propose_slide 또는 slides_propose_state로 변경안을 준비해 주세요. 저장본을 직접 덮어쓰지 말고 웹 편집기의 AI 변경 비교에서 선택 적용하도록 편집 링크를 주세요.";
    body.append(el("p", "설치 후 AI 앱을 완전히 종료했다가 다시 열고, 새 대화에서 아래 내용을 전달하세요. 실행 중인 MCP는 파일 업데이트만으로 재시작되지 않습니다."), prompt, copy("연결 확인 프롬프트 복사", () => prompt.value));
    const diagnosis = el("section"); diagnosis.id = "aiConnectionStatus"; diagnosis.setAttribute("aria-live", "polite");
    const refresh = el("button", "최근 연결 보고 다시 확인");
    async function load() {
      refresh.disabled = true; diagnosis.replaceChildren(el("p", "연결 보고를 불러오는 중…"));
      try {
        const { report, minimumVersion } = await api("/ai-connection");
        diagnosis.replaceChildren();
        if (!report) { diagnosis.append(el("p", "아직 MCP가 보낸 연결 보고가 없습니다. 위 프롬프트로 외부 PC에서 연결 확인을 실행하세요.")); return; }
        const time = report.reportedAt ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(report.reportedAt)) + " (KST)" : "기록 없음";
        diagnosis.append(el("p", `MCP 보고 버전 ${report.version} · 최근 연결 확인 ${time}`));
        const needUpdate = older(report.version, minimumVersion);
        diagnosis.append(el("p", needUpdate === true ? `업데이트 필요: 권장 최소 버전 ${minimumVersion}. 업데이트 후 MCP를 재시작하고 연결 확인을 다시 실행하세요.` : needUpdate === false ? "보고된 버전은 현재 최소 요구 버전을 충족합니다." : "보고된 버전 형식을 확인할 수 없습니다. 업데이트 후 다시 확인하세요."));
        const list = el("ul");
        for (const [key, label] of Object.entries(labels)) {
          const status = report.checks?.[key] || "unknown";
          list.append(el("li", `${label}: ${statuses[status] || statuses.unknown}${status !== "ok" ? " — " + remedies[key] : ""}`));
        }
        diagnosis.append(list);
      } catch { diagnosis.replaceChildren(el("p", "연결 보고를 가져오지 못했습니다. 웹사이트 로그인과 서버 접속을 확인하세요.")); }
      finally { refresh.disabled = false; }
    }
    refresh.onclick = load;
    body.append(diagnosis, refresh, el("p", "이 결과는 MCP가 마지막으로 보고한 상태입니다. 웹사이트는 외부 PC의 파일·설치 상태를 직접 검사하지 않습니다. 서버 접속·인증 실패로 보고를 전송하지 못하면 이전 기록이 유지되며, 실패 결과는 AI 앱에서 확인해야 합니다."), message);
    function render() { command.value = commands(platform.value, client.value); updateCommand.value = commands(platform.value, client.value, true); }
    platform.onchange = client.onchange = render; render(); await load();
  }
  window.SDAIConnection = { open };
})();
