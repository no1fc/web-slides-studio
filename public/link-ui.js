/* Link changes use the same validated revision and undo history as object edits. */
(() => {
  'use strict';
  let busy = false;
  $('dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  window.SDLinkUI = { update() {
    $('linkBtn').disabled = !selected || objectLocked(selected.id) || transitionBusy || objectBusy;
  } };
  SDLinkUI.update();
  $('linkBtn').onclick = action(() => {
    if (!selected || objectLocked(selected.id) || transitionBusy || objectBusy) return;
    const id = selected.id, context = objectContext();
    const current = { ...state.added.find(item => item.id === id), ...state.patches[id] }.link;
    const body = dialog('링크 · 페이지 이동');
    const field = (name, control) => { const label = el('label', name); label.append(control); body.append(label); return control; };
    body.append(el('p', '발표·공유·HTML에서 선택한 요소를 누르면 이동합니다. 편집 중에는 요소를 선택합니다.', 'tool-help'));
    const type = field('연결 대상', el('select')); type.id = 'linkTypeValue';
    for (const [value, name] of [['url', '웹 페이지'], ['slide', '이 발표의 슬라이드']]) { const option = el('option', name); option.value = value; type.append(option); }
    type.value = current?.type || 'url';
    const url = field('웹 주소 (https:// 또는 http://)', el('input')); url.id = 'linkUrlValue'; url.type = 'url'; url.placeholder = 'https://example.com'; url.maxLength = 2048; url.value = current?.url || '';
    const slides = field('이동할 페이지', el('select')); slides.id = 'linkSlideValue';
    for (const [position, slideId] of state.order.entries()) { const option = el('option', `${position + 1}. ${slideTitle(slideId)}${position === index ? ' (현재 페이지)' : ''}`); option.value = slideId; slides.append(option); }
    slides.value = current?.slideId || state.order[Math.min(index + 1, state.order.length - 1)];
    const error = el('p'); error.id = 'linkEditError'; error.setAttribute('role', 'alert'); body.append(error);
    if (current?.type === 'slide' && !state.order.includes(current.slideId)) error.textContent = '연결된 페이지가 삭제되었습니다. 새 페이지를 선택하거나 링크를 제거하세요.';
    const showType = () => { url.parentElement.hidden = type.value !== 'url'; slides.parentElement.hidden = type.value !== 'slide'; };
    type.onchange = showType; showType();
    const actions = el('div', undefined, 'actions'); body.append(actions);
    const apply = el('button', '적용', 'primary'); apply.id = 'applyLinkBtn';
    const remove = el('button', '링크 제거'); remove.id = 'removeLinkBtn'; remove.disabled = !current;
    actions.append(apply, remove);
    const save = value => {
      if (busy || transitionBusy) return;
      let link;
      try { link = SDObjects.normalizeLink(value); if (link?.type === 'slide' && !state.order.includes(link.slideId)) throw new Error('이동할 페이지를 선택해 주세요.'); }
      catch (e) { error.textContent = e.message; return; }
      const controls = [$('closeDialog'), ...body.querySelectorAll('input,select,button')], disabled = controls.map(control => control.disabled);
      busy = true; controls.forEach(control => { control.disabled = true; });
      return transitionAction(async () => {
        try {
          if (!currentObjectContext(context) || selected?.id !== id || objectLocked(id)) throw new Error('선택한 요소가 바뀌었습니다. 다시 선택해 주세요.');
          const candidate = clone(state); candidate.patches[id] = { ...candidate.patches[id], link };
          const validated = await validateObjectState(candidate, context);
          if (!validated) throw new Error('자료가 바뀌었습니다. 다시 시도해 주세요.');
          checkpoint(); state = validated; mark(); await flush(); refreshFrame([id]); $('dialog').close();
        } catch (e) { error.textContent = e.message; }
      }, '링크 저장 중…')().finally(() => {
        busy = false; controls.forEach((control, i) => { control.disabled = disabled[i]; }); SDLinkUI.update();
      });
    };
    apply.onclick = () => save(type.value === 'url' ? { type: 'url', url: url.value.trim() } : { type: 'slide', slideId: slides.value });
    remove.onclick = () => save(null);
  });
})();
