/* Arrangement controls reuse the bridge's edit transactions and validated image model. */
(() => {
  'use strict';
  const panel = document.querySelector('.arrangement-tools');
  if (!panel) return;
  const label = el('label', '정렬 기준', 'arrange-target');
  const target = el('select'); target.id = 'alignTargetValue';
  for (const [value, text] of [['selection', '선택 영역'], ['slide', '슬라이드']]) {
    const option = el('option', text); option.value = value; target.append(option);
  }
  label.append(target);
  const parentButton = el('button', '상위 개체 선택'); parentButton.id = 'selectParentBtn';
  const snapLabel = el('label', undefined, 'switch-row');
  const snap = el('input'); snap.type = 'checkbox'; snap.id = 'smartGuidesValue'; snap.checked = true;
  try { snap.checked = localStorage.getItem('sdlab-smart-guides') !== 'off'; } catch {}
  snapLabel.append(el('span', '스마트 안내선'), snap);
  const hint = panel.querySelector('.tool-help');
  hint.textContent = '개체 하나는 슬라이드에 맞춥니다. 여러 개는 정렬 기준을 선택하세요.';
  hint.before(label); panel.after(snapLabel, parentButton);
  const settings = () => post('settings', { alignToSlide: target.value === 'slide', snapping: snap.checked });
  target.onchange = settings;
  snap.onchange = () => { try { localStorage.setItem('sdlab-smart-guides', snap.checked ? 'on' : 'off'); } catch {} settings(); };
  snapLabel.title = '드래그할 때 가장자리·중심에 맞춥니다. Alt 키를 누르면 잠시 끕니다.';
  parentButton.onclick = action(() => { if (!parentButton.disabled) post('command', { name: 'select-parent' }); });
  const cropButton = el('button', '화면에서 자르기'); cropButton.id = 'visualCropBtn';
  $('imageSettingsBtn').after(cropButton);
  let multipleTarget = 'selection';
  window.SDArrangeUI = { update() {
    const count = selectedElements.length;
    if (count < 2 && !target.disabled) multipleTarget = target.value;
    if (count >= 2 && target.disabled) target.value = multipleTarget;
    if (count < 2) target.value = 'slide';
    target.disabled = count < 2 || !frameReady || objectBusy;
    parentButton.disabled = count !== 1 || !selected?.parentId || !frameReady || objectBusy;
    snap.disabled = !frameReady;
    cropButton.hidden = !selected || nativeAdded(selected.id)?.kind !== 'image';
    cropButton.disabled = cropButton.hidden || objectLocked(selected.id) || !frameReady || objectBusy;
  } };
  window.addEventListener('message', event => {
    if (!deck || event.source !== frame.contentWindow || event.origin !== new URL(deck.previewUrl).origin || !event.data?.studio || event.data.editorSession !== editorSession) return;
    if (event.data.type === 'ready') settings();
    if (['ready', 'select', 'layers'].includes(event.data.type)) { SDArrangeUI.update(); settings(); }
  });
  SDArrangeUI.update();
  cropButton.onclick = action(openCrop);

  function openCrop() {
    if (cropButton.disabled) return;
    const id = selected.id, context = objectContext(), original = nativeAdded(id);
    const current = SDObjects.normalizeImage(state.patches[id]?.image || selected.image || original.image);
    const source = state.patches[id]?.src || original.src;
    const width = selected.w, height = selected.h;
    const body = dialog('이미지 자르기');
    body.classList.add('visual-crop-dialog');
    const help = el('p', '영역을 끌어 위치를 바꾸고 모서리나 크기 조절 막대로 자르세요. 슬라이드 속 이미지 비율을 유지하며 원본 파일은 보존합니다.', 'tool-help');
    const modeLabel = el('label', '프레임 맞춤');
    const mode = el('select'); mode.id = 'visualCropMode';
    for (const [value, text] of [['fill', '채우기 · 자르기'], ['fit', '전체 이미지 맞춤']]) { const option = el('option', text); option.value = value; mode.append(option); }
    mode.value = current.mode === 'fit' ? 'fit' : 'fill'; modeLabel.append(mode);
    const stage = el('div', undefined, 'crop-stage');
    const surface = el('div', undefined, 'crop-surface');
    const image = el('img'); image.alt = '자르기 원본'; image.draggable = false;
    const region = el('div', undefined, 'crop-region'); region.id = 'visualCropRegion'; region.tabIndex = 0;
    region.setAttribute('role', 'group'); region.setAttribute('aria-label', '자르기 영역 · 방향키로 이동, Shift와 함께 누르면 크게 이동');
    for (const corner of ['nw', 'ne', 'se', 'sw']) {
      const handle = el('button'); handle.type = 'button'; handle.dataset.corner = corner;
      handle.tabIndex = -1; handle.setAttribute('aria-label', '자르기 크기 조절'); region.append(handle);
    }
    surface.append(image, region); stage.append(surface);
    const sizeLabel = el('label', '자르기 영역 크기');
    const size = el('input'); size.id = 'visualCropSize'; size.type = 'range'; size.min = '1'; size.max = '100'; size.step = '0.1'; sizeLabel.append(size);
    const status = el('p', undefined, 'tool-help'); status.id = 'visualCropStatus'; status.setAttribute('aria-live', 'polite');
    const error = el('p'); error.id = 'visualCropError'; error.setAttribute('role', 'alert');
    const actions = el('div', undefined, 'actions');
    const reset = el('button', '자르기 초기화'); reset.id = 'visualCropReset';
    const apply = el('button', '적용', 'primary'); apply.id = 'applyVisualCropBtn'; apply.disabled = true;
    actions.append(reset, apply); body.append(help, modeLabel, stage, sizeLabel, status, error, actions);
    let box, maximum, pointer, busy = false, loaded = false;
    const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
    const centered = (w, h, cx = .5, cy = .5) => ({ x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h });
    function render() {
      if (!loaded) return;
      region.hidden = mode.value === 'fit'; sizeLabel.hidden = mode.value === 'fit';
      Object.assign(region.style, { left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%` });
      size.value = String(box.w / maximum.w * 100);
      status.textContent = mode.value === 'fit' ? '원본 전체가 이미지 프레임 안에 표시됩니다.' : `원본의 가로 ${(box.w * 100).toFixed(1)}%, 세로 ${(box.h * 100).toFixed(1)}% 사용 · 방향키로 영역 이동`;
    }
    image.onload = () => {
      if (!$('dialog').open || !image.isConnected) return;
      image.style.width = `${Math.min(600, window.innerHeight * .4 * image.naturalWidth / image.naturalHeight)}px`;
      const ratio = width / height * image.naturalHeight / image.naturalWidth;
      if (ratio < .01 || ratio > 100) { error.textContent = '이 이미지 비율은 화면 자르기를 지원하지 않습니다. 전체 이미지 맞춤이나 기존 자르기 값을 이용해 주세요.'; return; }
      maximum = ratio >= 1 ? { w: 1, h: 1 / ratio } : { w: ratio, h: 1 };
      const cw = 1 - current.crop.left - current.crop.right, ch = 1 - current.crop.top - current.crop.bottom;
      const factor = Math.min(cw / maximum.w, ch / maximum.h);
      box = centered(maximum.w * factor, maximum.h * factor, current.crop.left + cw / 2, current.crop.top + ch / 2);
      loaded = true; apply.disabled = false; render();
    };
    image.onerror = () => { error.textContent = '원본 이미지를 불러오지 못했습니다. 이미지 파일을 확인한 뒤 다시 시도하세요.'; apply.disabled = true; };
    image.src = new URL(source, deck.previewUrl).href;
    mode.onchange = render;
    reset.onclick = () => { if (loaded) { box = centered(maximum.w, maximum.h); render(); } };
    size.oninput = () => {
      if (!loaded) return;
      // The stored crop model retains at least 1% of each source dimension.
      const factor = clamp(Number(size.value) / 100, Math.max(.01 / maximum.w, .01 / maximum.h), 1);
      box = centered(maximum.w * factor, maximum.h * factor, box.x + box.w / 2, box.y + box.h / 2); render();
    };
    region.onkeydown = event => {
      if (!loaded || busy || event.isComposing || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      const step = event.shiftKey ? .05 : .005;
      box.x = clamp(box.x + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0), 0, 1 - box.w);
      box.y = clamp(box.y + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0), 0, 1 - box.h); render();
    };
    region.onpointerdown = event => {
      if (!loaded || busy || event.button !== 0 || !event.isPrimary) return;
      event.preventDefault(); region.focus();
      const rect = surface.getBoundingClientRect();
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, box: { ...box }, rect, corner: event.target.dataset.corner };
      region.setPointerCapture(event.pointerId);
    };
    region.onpointermove = event => {
      if (!pointer || pointer.id !== event.pointerId) return;
      const p = pointer, dx = (event.clientX - p.x) / p.rect.width, dy = (event.clientY - p.y) / p.rect.height;
      if (!p.corner) box = { ...p.box, x: clamp(p.box.x + dx, 0, 1 - box.w), y: clamp(p.box.y + dy, 0, 1 - box.h) };
      else {
        const right = p.corner.includes('e'), bottom = p.corner.includes('s');
        const anchorX = p.box.x + (right ? 0 : p.box.w), anchorY = p.box.y + (bottom ? 0 : p.box.h);
        const delta = Math.abs(dx / maximum.w) >= Math.abs(dy / maximum.h) ? dx / maximum.w * (right ? 1 : -1) : dy / maximum.h * (bottom ? 1 : -1);
        const max = Math.min((right ? 1 - anchorX : anchorX) / maximum.w, (bottom ? 1 - anchorY : anchorY) / maximum.h);
        const factor = clamp(p.box.w / maximum.w + delta, Math.max(.01 / maximum.w, .01 / maximum.h), max);
        const w = maximum.w * factor, h = maximum.h * factor;
        box = { x: right ? anchorX : anchorX - w, y: bottom ? anchorY : anchorY - h, w, h };
      }
      render();
    };
    const finish = (event, cancel) => {
      if (!pointer || pointer.id !== event.pointerId) return;
      if (cancel) { box = pointer.box; render(); }
      pointer = null; if (region.hasPointerCapture(event.pointerId)) region.releasePointerCapture(event.pointerId);
    };
    region.onpointerup = event => finish(event, false);
    region.onpointercancel = event => finish(event, true);
    region.onlostpointercapture = event => finish(event, true);
    const dialogElement = $('dialog');
    const preventClose = event => { if (busy) event.preventDefault(); };
    dialogElement.addEventListener('cancel', preventClose);
    dialogElement.addEventListener('close', () => {
      dialogElement.removeEventListener('cancel', preventClose); body.classList.remove('visual-crop-dialog');
      if (cropButton.isConnected && !cropButton.disabled) cropButton.focus();
    }, { once: true });
    apply.onclick = async () => {
      if (!loaded || busy) return;
      if (!currentObjectContext(context) || selected?.id !== id || objectLocked(id)) { error.textContent = '선택한 이미지가 바뀌었습니다. 닫고 다시 선택해 주세요.'; return; }
      const crop = mode.value === 'fit' ? { left: 0, right: 0, top: 0, bottom: 0 } : { left: box.x, top: box.y, right: Math.max(0, 1 - box.x - box.w), bottom: Math.max(0, 1 - box.y - box.h) };
      const imageValue = SDObjects.normalizeImage({ mode: mode.value, crop });
      busy = true; const controls = [$('closeDialog'), ...body.querySelectorAll('button,input,select')]; controls.forEach(control => { control.disabled = true; });
      try {
        await visualPatch('image', imageValue);
        if (currentObjectContext(context) && selected?.id === id && JSON.stringify(state.patches[id]?.image) === JSON.stringify(imageValue)) dialogElement.close();
        else error.textContent = '이미지 변경을 적용하지 못했습니다. 현재 자료와 선택 상태를 확인해 주세요.';
      } catch (err) { error.textContent = err.message; }
      finally { busy = false; controls.forEach(control => { control.disabled = false; }); SDArrangeUI.update(); }
    };
  }
})();
