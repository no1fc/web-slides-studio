/* The presentation editor keeps its existing controls, saves and iframe bridge. */
(() => {
  'use strict';
  const editor=$('editor'), toolbar=editor.querySelector('.editor-toolbar'), ribbon=$('editorRibbon');
  const body=editor.querySelector('.editor-body'), inspector=editor.querySelector('.inspector');
  const icon=name=>window.SDIcons.icon(name);
  function decorate(button,name,label,only=false){
    button.setAttribute('aria-label',label);button.title=label;
    button.replaceChildren(icon(name));if(!only)button.append(el('span',label));
    button.classList.toggle('shell-icon-button',only);return button;
  }
  function button(id,name,label,handler,only=false){
    const node=el('button');node.id=id;node.type='button';decorate(node,name,label,only);node.onclick=handler;return node;
  }
  document.body.classList.add('editor-shell-ready');
  const syncPage=()=>document.body.classList.toggle('editing-deck',!editor.hidden);
  new MutationObserver(syncPage).observe(editor,{attributes:true,attributeFilter:['hidden']});syncPage();

  const left=el('div',undefined,'shell-header-left'), title=el('div',undefined,'shell-header-title'), right=el('div',undefined,'shell-header-right');
  left.append(decorate($('libraryBtn'),'chevron-left','자료실로 돌아가기',true));
  title.append($('deckTitle'));toolbar.prepend(left,title);toolbar.append(right);
  toolbar.querySelector('.toolbar-spacer')?.remove();
  const menus=el('div',undefined,'shell-menus');left.append(menus);
  ribbon.setAttribute('popover','auto');ribbon.classList.remove('ribbon-collapsed');
  let menuOpener=null;
  function openTools(tab,opener){
    menuOpener=opener;ribbon.classList.remove('ribbon-collapsed');
    $(tab).click();ribbon.showPopover();
    $(tab).focus();
  }
  for(const [id,label,tab] of [['slideToolsBtn','슬라이드','ribbon-format-tab'],['insertToolsBtn','삽입','ribbon-insert-tab'],['designToolsBtn','디자인','ribbon-slide-tab'],['fileToolsBtn','파일','ribbon-file-tab']]){
    const node=button(id,'chevron-down',label,()=>openTools(tab,node));
    node.setAttribute('aria-haspopup','true');node.setAttribute('aria-controls','editorRibbon');menus.append(node);
  }
  const mobileTools=button('editorToolsBtn','ellipsis','편집 도구',()=>openTools('ribbon-format-tab',mobileTools),true);mobileTools.classList.add('shell-mobile-tools');left.append(mobileTools);
  mobileTools.setAttribute('aria-haspopup','true');mobileTools.setAttribute('aria-controls','editorRibbon');
  for(const node of [...menus.children,mobileTools])node.setAttribute('aria-expanded','false');
  ribbon.addEventListener('toggle',event=>{
    for(const node of [...menus.children,mobileTools])node.setAttribute('aria-expanded',String(event.newState==='open'&&node===menuOpener));
    if(event.newState==='closed'&&ribbon.contains(document.activeElement))menuOpener?.focus();
  });
  ribbon.addEventListener('keydown',event=>event.stopPropagation());
  ribbon.addEventListener('click',event=>{
    const target=event.target.closest('button');
    if(target&&!target.matches('[role=tab]')&&!target.closest('dialog')&&ribbon.matches(':popover-open'))ribbon.hidePopover();
  });
  $('collapseRibbonBtn').onclick=()=>ribbon.hidePopover();
  decorate($('collapseRibbonBtn'),'x','편집 도구 닫기',true);
  ribbon.querySelector('.ribbon-hint')?.remove();
  const nav=ribbon.querySelector('.editor-navigation');nav.append($('collapseRibbonBtn'));
  $('ribbon-format-tab').textContent='슬라이드';
  const help=document.querySelector('.topbar .help-link').cloneNode(true);help.id='editorHelpLink';$('ribbon-file').append(help);

  const modes=el('div',undefined,'shell-mode-switch');modes.setAttribute('role','group');modes.setAttribute('aria-label','편집과 검토');
  const editMode=button('editModeBtn','pencil','편집',()=>{setPanel(true);setInspectorTab('format');},true);
  editMode.setAttribute('aria-pressed','true');modes.append(editMode);
  const feedback=$('feedbackBtn');decorate(feedback,'message-square','수정 요청 목록',true);modes.append(feedback);
  right.append(modes,decorate($('commandSearchBtn'),'search','도구 찾기 (Ctrl/⌘+Shift+P)',true),decorate($('shareBtn'),'link-2','공유',true),decorate($('exportBtn'),'download','다운로드',true));
  $('exportBtn').classList.remove('primary');
  const panelToggle=button('inspectorToggleBtn','panel-right','서식',()=>setPanel(inspector.hidden));right.append(panelToggle);
  right.append(decorate($('previewBtn'),'play','발표'));
  const more=button('editorSettingsBtn','settings','설정',()=>$('settingsBtn').click(),true);right.append(more);
  const objectActions=toolbar.querySelector('.object-actions');if(objectActions)$('ribbon-arrange').append(objectActions);
  const history=el('div',undefined,'shell-history');
  history.append(decorate($('undoBtn'),'undo-2','실행 취소 (Ctrl+Z)',true),decorate($('redoBtn'),'redo-2','다시 실행 (Ctrl+Shift+Z)',true));
  const canvasMain=body.querySelector('.canvas-main');canvasMain.append(history);

  const rail=body.querySelector('.slide-rail'),railHead=rail.querySelector('.rail-head');
  const splitter=el('div',undefined,'shell-rail-splitter');splitter.id='slideRailResize';splitter.tabIndex=0;
  for(const [name,value]of Object.entries({role:'separator','aria-orientation':'vertical','aria-label':'슬라이드 목록 너비','aria-valuemin':'200','aria-valuemax':'480'}))splitter.setAttribute(name,value);
  let railWidth=264,railDrag=null;
  try{const saved=Number(localStorage.getItem('sdlab:slides:rail-width'));if(saved>=200&&saved<=480)railWidth=saved;}catch{}
  function sizeRail(value,save=false){
    railWidth=Math.max(200,Math.min(480,value));editor.style.setProperty('--shell-rail-width',railWidth+'px');splitter.setAttribute('aria-valuenow',String(railWidth));
    if(save)try{localStorage.setItem('sdlab:slides:rail-width',String(railWidth));}catch{}
  }
  splitter.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();railDrag={x:event.clientX,width:railWidth};splitter.setPointerCapture(event.pointerId);editor.classList.add('rail-resizing');};
  splitter.onpointermove=event=>{if(railDrag)sizeRail(railDrag.width+event.clientX-railDrag.x);};
  const endResize=event=>{if(!railDrag)return;railDrag=null;editor.classList.remove('rail-resizing');if(splitter.hasPointerCapture(event.pointerId))splitter.releasePointerCapture(event.pointerId);sizeRail(railWidth,true);};
  splitter.onpointerup=endResize;splitter.onpointercancel=endResize;splitter.onlostpointercapture=endResize;
  splitter.ondblclick=()=>sizeRail(264,true);
  splitter.onkeydown=event=>{
    const step=event.shiftKey?32:8,value=event.key==='ArrowLeft'?railWidth-step:event.key==='ArrowRight'?railWidth+step:event.key==='Home'?264:null;
    if(value!==null){event.preventDefault();event.stopPropagation();sizeRail(value,true);}
  };
  rail.append(splitter);sizeRail(railWidth);
  railHead.querySelector('strong').textContent='슬라이드';
  const railActions=el('div',undefined,'shell-rail-actions');
  railActions.append(decorate($('slideOverviewBtn'),'layout-grid','전체 슬라이드',true),decorate($('addSlideBtn'),'plus','빈 슬라이드 추가',true));railHead.append(railActions);
  const slideActions=rail.querySelector('.slide-actions');$('ribbon-format').append(slideActions);
  slideActions.prepend(button('paletteAddSlideBtn','plus','빈 슬라이드 추가',()=>$('addSlideBtn').click()));
  $('ribbon-format').append(el('p','왼쪽 슬라이드를 선택하거나 끌어서 순서를 바꾸세요.','tool-help'));

  const notes=$('notesPanel'),summary=notes.querySelector('summary');editor.append(notes);
  const notesText=el('span','발표자 노트');summary.replaceChildren(icon('notebook-pen'),notesText,$('slideLabel'),$('notesCount'));
  const notesEnd=el('span',undefined,'shell-notes-end');notesEnd.append($('saveStatus'),document.querySelector('.zoom-control'));summary.append(notesEnd);
  const notesChevron=icon('chevron-down');notesChevron.classList.add('shell-notes-chevron');summary.append(notesChevron);
  notesEnd.addEventListener('click',event=>{event.stopPropagation();if(!event.target.closest('select,input,button,a'))event.preventDefault();});
  notesEnd.addEventListener('keydown',event=>event.stopPropagation());
  const canvasTools=canvasMain.querySelector('.canvas-tools');canvasTools.remove();
  const selectionLabel=$('selectedLabel');canvasMain.querySelector('.canvas-footer').remove();

  const panelHeader=inspector.querySelector('.inspector-tabs'),selectionCount=$('selectionCount');
  panelHeader.replaceChildren(el('strong','서식'),button('closeInspectorBtn','x','서식 닫기',()=>setPanel(false),true));
  const panelNav=el('div',undefined,'shell-inspector-nav'),selectionHeading=el('div',undefined,'shell-selection-heading');
  selectionHeading.append(selectionLabel,selectionCount);inspector.append(selectionHeading,panelNav);
  panelNav.setAttribute('role','tablist');panelNav.setAttribute('aria-label','선택한 대상 도구');
  const scroll=el('div',undefined,'shell-inspector-scroll');inspector.append(scroll);
  const panels={};
  let inspectorTab='format';
  for(const [key,name,label] of [['format','type','서식'],['arrange','move','배치'],['layers','layers','레이어']]){
    const tab=button('inspector-'+key+'-tab',name,label,()=>setInspectorTab(key));
    tab.setAttribute('role','tab');tab.setAttribute('aria-controls','inspector-'+key);panelNav.append(tab);
    const panel=el('section');panel.id='inspector-'+key;panel.setAttribute('role','tabpanel');panel.setAttribute('aria-labelledby',tab.id);scroll.append(panel);panels[key]=panel;
    tab.addEventListener('keydown',event=>{
      const tabs=[...panelNav.children],at=tabs.indexOf(tab);
      const next=event.key==='ArrowRight'?(at+1)%tabs.length:event.key==='ArrowLeft'?(at+tabs.length-1)%tabs.length:event.key==='Home'?0:event.key==='End'?tabs.length-1:-1;
      if(next>=0){event.preventDefault();tabs[next].click();tabs[next].focus();}
    });
  }
  const selection=inspector.querySelector('.selection-properties'),properties=$('properties');
  panels.format.append($('noSelection'),properties);
  $('noSelection').prepend(icon('mouse-pointer-2'),el('h3','대상을 선택하세요'));
  $('selectionHelp').textContent='슬라이드의 글·이미지·도형을 선택하면 여기에서 편집할 수 있습니다. 글은 더블클릭해 수정하세요.';
  properties.append(selection.querySelector('.ribbon-object-actions'));
  const request=$('requestFeedbackBtn');if(request)properties.append(request);
  panels.arrange.append(selection,document.querySelector('.arrangement-panel'));
  const layers=inspector.querySelector('.layers-panel');panels.layers.append(layers);
  layers.prepend(document.querySelector('.layer-order-actions'));
  $('ribbon-arrange').append(button('showLayersBtn','layers','레이어 목록',()=>{setInspectorTab('layers');setPanel(true);}));
  for(const key of ['format','arrange'])$('ribbon-'+key+'-tab').addEventListener('click',()=>{setInspectorTab(key);setPanel(true);});
  function setInspectorTab(key){
    inspectorTab=key;
    for(const [name,panel] of Object.entries(panels)){
      panel.hidden=name!==key;const tab=$('inspector-'+name+'-tab');tab.setAttribute('aria-selected',String(name===key));tab.tabIndex=name===key?0:-1;
    }
    syncInspector();
  }
  function syncInspector(){
    const multiple=selectedElements.length>1;$('inspector-format-tab').disabled=multiple;
    if(multiple&&inspectorTab==='format'){setInspectorTab('arrange');return;}
    const empty=properties.hidden&&inspectorTab==='format';selectionHeading.hidden=empty;panelNav.hidden=empty;
    if(empty)$('selectionHelp').textContent='슬라이드의 글·이미지·도형을 선택하면 여기에서 편집할 수 있습니다. 글은 더블클릭해 수정하세요.';
  }
  new MutationObserver(syncInspector).observe(properties,{attributes:true,attributeFilter:['hidden']});
  function setPanel(open){if(!open&&inspector.contains(document.activeElement))panelToggle.focus();inspector.hidden=!open;editor.classList.toggle('inspector-closed',!open);panelToggle.setAttribute('aria-expanded',String(open));panelToggle.setAttribute('aria-pressed',String(open));}
  setInspectorTab('format');setPanel(innerWidth>=1024);
})();
