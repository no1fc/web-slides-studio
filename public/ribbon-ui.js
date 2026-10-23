(() => {
  const $ = id => document.getElementById(id);
  const ribbon = $('editorRibbon');
  const home = $('ribbon-format-tab'); home.parentElement.prepend(home);
  const tabs = [...ribbon.querySelectorAll('[role="tab"]')];
  function activate(tab) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      $(item.getAttribute('aria-controls')).hidden = !selected;
    }
    if (tab.id === 'ribbon-slide-tab') $('ribbon-slide').append($('effectsBtn'));
    if (tab.id === 'ribbon-transition-tab') $('ribbon-transition').append($('effectsBtn'));
    if (tab.id === 'ribbon-insert-tab') $('ribbon-insert').prepend(quickInsert);
    else ribbon.querySelector('.ribbon-tabs').append(quickInsert);
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => activate(tab));
    tab.addEventListener('keydown', event => {
      let index = tabs.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') index = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = tabs.length - 1;
      else return;
      event.preventDefault();
      activate(tabs[index]);
      tabs[index].focus();
    });
  }
  function group(parent, label, nodes, className = '') {
    const section = document.createElement('div');
    section.className = 'ribbon-group ' + className;
    section.setAttribute('role', 'group');
    section.setAttribute('aria-label', label);
    for (const node of nodes) section.append(node);
    parent.append(section);
    return section;
  }
  function settings(parent, id, title, nodes) {
    const button = document.createElement('button');
    button.id = id + 'Btn';
    button.type = 'button';
    button.textContent = title + '…';
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-controls', id);
    const dialog = document.createElement('dialog');
    dialog.id = id;
    dialog.className = 'ribbon-settings';
    dialog.setAttribute('aria-labelledby', id + 'Title');
    const heading = document.createElement('div');
    heading.className = 'dialog-head';
    const h2 = document.createElement('h2');
    h2.id = id + 'Title';
    h2.textContent = title;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '닫기';
    close.addEventListener('click', () => dialog.close());
    heading.append(h2, close);
    const body = document.createElement('div');
    body.className = 'ribbon-settings-body';
    body.append(...nodes);
    dialog.append(heading, body);
    dialog.addEventListener('keydown', event => event.stopPropagation());
    parent.append(button, dialog);
    button.addEventListener('click', () => dialog.showModal());
    return button;
  }

  const quickInsert = document.querySelector('.add-tools');
  quickInsert.append($('linkBtn'));
  ribbon.querySelector('.ribbon-tabs').append(quickInsert);
  document.querySelector('.editor-toolbar').insertBefore(document.querySelector('.object-actions'), $('previewBtn'));
  const insertHelp = document.createElement('p');
  insertHelp.className = 'tool-help';
  insertHelp.textContent = '현재 슬라이드에 개체를 추가합니다. 링크는 선택한 개체에 연결합니다.';
  $('ribbon-insert').append(insertHelp);
  group($('ribbon-file'), '파일과 기록', ['filesBtn', 'versionsBtn'].map($));
  const advanced=document.createElement('details'); advanced.id='advancedTools'; const summary=document.createElement('summary'); summary.textContent='고급 도구'; advanced.append(summary); group(advanced,'코드와 공통 구성',['codeBtn','jsonBtn','masterBtn'].map($)); $('ribbon-file').append(advanced);
  group($('ribbon-slide'), '슬라이드 디자인', ['layoutBtn', 'themeBtn'].map($));
  $('ribbon-slide').append(document.querySelector('.background-panel'));
  $('ribbon-transition').append($('effectsBtn'));
  // Keep the design entry point while sharing the same effects editor.
  const effectShortcut=document.createElement('button'); effectShortcut.textContent='전환·효과…'; effectShortcut.onclick=()=>$('effectsBtn').click(); $('ribbon-slide').append(effectShortcut);
  $('ribbon-arrange').append(document.querySelector('.arrangement-panel'));
  group($('ribbon-arrange'), '앞뒤 순서', [document.querySelector('.layer-order-actions')]);
  document.querySelector('.inspector-tabs').append($('selectionCount'));
  $('ribbon-format').append($('noSelection'), $('properties'));
  $('selectionHelp').textContent = '슬라이드에서 글·이미지·도형을 선택하면 서식 도구가 나타납니다.';

  const properties = $('properties');
  const textTools = $('textTools');
  settings(textTools, 'paragraphSettings', '문단·텍스트 상자', [...textTools.querySelectorAll('.text-section')]);
  textTools.querySelector('.panel-heading').remove();
  const geometry = $('xValue').closest('.prop-grid');
  geometry.classList.add('ribbon-geometry');
  const dimensions = group(properties, '위치와 크기', [geometry, $('lockAspect').closest('label')], 'ribbon-dimensions');
  dimensions.id = 'geometryTools';
  const actions = group(properties, '선택한 개체 편집', [], 'ribbon-object-actions');
  const editText = settings(actions, 'textContentSettings', '내용 편집', [$('textField')]);
  const image = settings(actions, 'imageSettings', '이미지 자르기·맞춤', [$('imageTools')]);
  const shape = settings(actions, 'shapeSettings', '도형 서식', [$('shapeTools')]);
  actions.append($('replaceImageBtn'), $('editDataBtn'));
  settings(actions, 'objectSettings', '기타 속성', [
    $('fillField').closest('.prop-grid'), $('precisionNote'), $('originalImageNote'), $('groupNote'), $('textUnavailableNote'), $('removeElementBtn'),
  ]);
  textTools.append($('textOverflowNote'));
  properties.prepend(textTools);
  textTools.append($('textAlignValue').closest('label'));
  const side=document.createElement('section'); side.className='selection-properties'; side.setAttribute('aria-label','선택한 대상 속성'); side.append(dimensions,actions);
  document.querySelector('.inspector-tabs').after(side);
  const sync = () => {
    side.hidden=properties.hidden;
    for (const [button, field] of [[editText, $('textField')], [image, $('imageTools')], [shape, $('shapeTools')]]) {
      if (button.hidden !== field.hidden) button.hidden = field.hidden;
    }
    for (const dialog of document.querySelectorAll('#properties dialog[open],.selection-properties dialog[open]')) {
      if (properties.hidden) dialog.close();
    }
  };
  new MutationObserver(sync).observe(properties, { subtree: true, attributes: true, attributeFilter: ['hidden'] });
  sync();
  new ResizeObserver(() => {
    $('editor').style.setProperty('--editor-ribbon-height', `${ribbon.offsetHeight}px`);
  }).observe(ribbon);
})();
