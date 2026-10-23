/* Navigation reuses the editor's actions, revision saves and lazy thumbnail rows. */
(() => {
  'use strict';
  const ribbon = $('editorRibbon'), tabs = ribbon.querySelector('.ribbon-tabs');
  const controls = el('div', undefined, 'editor-navigation');
  const search = el('button', '도구 찾기'), overview = el('button', '전체 슬라이드'), collapse = el('button', '도구 접기');
  search.id = 'commandSearchBtn'; overview.id = 'slideOverviewBtn'; collapse.id = 'collapseRibbonBtn';
  search.title = '도구 찾기 (Ctrl/⌘+Shift+P)';
  search.setAttribute('aria-keyshortcuts', 'Control+Shift+P Meta+Shift+P');
  for (const button of [search, overview, collapse]) button.type = 'button';
  controls.append(search, overview, collapse); tabs.append(controls);
  const setCollapsed = value => {
    if (ribbon.hasAttribute('popover')) return;
    ribbon.classList.toggle('ribbon-collapsed', value);
    collapse.textContent = value ? '도구 펼치기' : '도구 접기';
    collapse.setAttribute('aria-expanded', String(!value));
  };
  setCollapsed(false);
  collapse.onclick = () => setCollapsed(!ribbon.classList.contains('ribbon-collapsed'));
  tabs.querySelectorAll('[role=tab]').forEach(tab => tab.addEventListener('click', () => setCollapsed(false)));

  function navigationDialog(id, title) {
    const modal = el('dialog', undefined, 'navigation-dialog'); modal.id = id;
    const header = el('div', undefined, 'dialog-head'), heading = el('h2', title), close = el('button', '닫기');
    heading.id = id + 'Title'; modal.setAttribute('aria-labelledby', heading.id);
    close.type = 'button'; close.onclick = () => modal.close();
    header.append(heading, close); modal.append(header); document.body.append(modal);
    modal.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape' && !event.isComposing) { event.preventDefault(); modal.close(); }
    });
    return modal;
  }
  const commandsDialog = navigationDialog('commandSearchDialog', '도구 찾기');
  const query = el('input'), results = el('div'), help = el('p', '기능이나 슬라이드 제목을 입력하세요. ↑↓ 이동 · Enter 실행 · Esc 닫기', 'tool-help');
  query.id = 'commandQuery'; query.type = 'search'; query.placeholder = '예: 표 삽입, 테마, 발표, 3번 슬라이드';
  query.setAttribute('aria-label', '찾을 도구 또는 슬라이드'); query.setAttribute('aria-controls', 'commandResults');
  results.id = 'commandResults'; commandsDialog.append(query, help, results);
  const toolSpecs = [
    ['addSlideBtn', '빈 슬라이드 추가'], ['addTextBtn', '글 삽입'], ['addImageBtn', '이미지 삽입'],
    ['addShapeBtn', '도형 삽입'], ['addTableBtn', '표 삽입'], ['addChartBtn', '차트 삽입'], ['linkBtn', '링크 연결'],
    ['editDataBtn', '선택한 표·차트 데이터 편집'], ['layoutBtn', '슬라이드 레이아웃'], ['themeBtn', '발표 테마'],
    ['templatesBtn', '템플릿으로 새 자료 만들기'], ['brandsBtn', '브랜드 설정'], ['effectsBtn', '슬라이드 전환·효과'],
    ['previewBtn', '발표 시작'], ['preflightBtn', '발표 전 점검'], ['shareBtn', '공유 설정'],
    ['exportBtn', '발표 자료 다운로드'], ['versionsBtn', '버전 기록·복원'], ['aiChangesBtn', 'AI 변경안 확인'],
    ['feedbackBtn', 'AI 수정 요청 목록'], ['requestFeedbackBtn', '선택 개체에 AI 수정 요청'],
    ['slideOverviewBtn', '전체 슬라이드 보기'], ['undoBtn', '실행 취소'], ['redoBtn', '다시 실행'],
  ];
  async function navigate(row) {
    const id = deck.id;
    await settleEditing(); await flush();
    if (deck?.id !== id || !row.isConnected || transitionBusy) return;
    row.click();
  }
  function showResults() {
    results.replaceChildren();
    const terms = query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const commands = toolSpecs.filter(([id]) => $(id) && !$(id).disabled && !$(id).hidden)
      .map(([id, label]) => ({label, run: () => $(id).click()}));
    if (terms.length) for (const row of $('slideList').children) {
      commands.push({label: row.getAttribute('aria-label'), run: () => navigate(row)});
    }
    for (const command of commands.filter(command => terms.every(term => command.label.toLocaleLowerCase().includes(term)))) {
      const button = el('button', command.label); button.type = 'button';
      button.onclick = () => { commandsDialog.close(); Promise.resolve(command.run()).catch(error => toast(error.message)); };
      results.append(button);
    }
    if (!results.childElementCount) results.append(el('p', '일치하는 도구나 슬라이드를 찾을 수 없습니다.'));
  }
  query.oninput = showResults;
  commandsDialog.addEventListener('keydown', event => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
    const buttons = [...results.querySelectorAll('button')], at = buttons.indexOf(document.activeElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault(); buttons[Math.max(0, Math.min(buttons.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
    } else if (event.key === 'Enter' && event.target === query) { event.preventDefault(); buttons[0]?.click(); }
  });
  search.onclick = () => {
    if (!deck || transitionBusy || document.querySelector('dialog[open]')) return;
    query.value = ''; showResults(); commandsDialog.showModal(); query.focus();
  };
  commandsDialog.addEventListener('close', () => search.focus());
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName)) return;
    if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p' && deck && !$('editor').hidden && !document.querySelector('dialog[open]')) {
      event.preventDefault(); search.click();
    }
  });
  window.addEventListener('message', event => {
    if (deck && event.source === frame.contentWindow && event.origin === new URL(deck.previewUrl).origin && event.data?.studio === true && event.data.type === 'command-search' && event.data.editorSession === editorSession) search.click();
  });

  const overviewDialog = navigationDialog('slideOverviewDialog', '전체 슬라이드');
  overviewDialog.append(el('p', '방향키로 살펴보고 Enter로 이동하세요. Esc로 닫습니다.', 'tool-help'));
  const list = $('slideList'), home = list.parentElement, next = list.nextSibling;
  overview.onclick = action(async () => {
    if (!deck || transitionBusy || document.querySelector('dialog[open]')) return;
    await flush();
    if (document.querySelector('dialog[open]')) return;
    overviewDialog.append(list); overviewDialog.showModal();
    list.querySelector('[aria-current=true]')?.focus();
  });
  overviewDialog.addEventListener('close', () => { home.insertBefore(list, next); overview.focus(); });
  list.addEventListener('click', event => {
    if (!overviewDialog.open) return;
    const row = event.target.closest('.slide-item'); if (!row) return;
    event.preventDefault(); event.stopImmediatePropagation();
    overviewDialog.close(); navigate(row).catch(error => toast(error.message));
  }, true);
  overviewDialog.addEventListener('keydown', event => {
    if (event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !list.contains(event.target)) return;
    const rows = [...list.children], at = rows.indexOf(event.target.closest('.slide-item'));
    const columns = Math.max(1, Math.floor(list.clientWidth / rows[0].getBoundingClientRect().width));
    const target = {ArrowLeft: at - 1, ArrowRight: at + 1, ArrowUp: at - columns, ArrowDown: at + columns, Home: 0, End: rows.length - 1}[event.key];
    if (target !== undefined) { event.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, target))]?.focus(); }
  });
})();
