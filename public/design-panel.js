(() => {
  const panel=$('inspector-design'), controls={}, history=[], future=[];
  let original=null, draft=null, context=null, previewing=false;
  const top=el('button');top.id='designPanelBtn';top.type='button';top.title='전체 디자인';top.setAttribute('aria-label','전체 디자인');top.className='shell-icon-button';top.append(SDIcons.icon('palette'));
  $('inspectorToggleBtn').before(top);
  panel.append(el('h3','전체 디자인'),el('p','테마에 연결된 색상·글꼴·크기·모서리를 바꿉니다. 개별 지정한 디자인은 유지합니다. 적용 전에는 저장하지 않습니다.','tool-help'));
  const fields=[['background','배경색','color'],['text','본문색','color'],['accent','강조색','color'],['heading','제목 글꼴','text'],['body','본문 글꼴','text'],['headingSize','제목 크기','number',48,240,2],['bodySize','본문 크기','number',16,72,1],['radius','모서리 반경','number',0,80,1]];
  for(const [key,label,type,min,max,step] of fields){
    const wrap=el('label',label),input=el('input');input.type=type;input.id='design'+key[0].toUpperCase()+key.slice(1);input.setAttribute('aria-label',label);controls[key]=input;
    if(type==='number'){input.min=min;input.max=max;input.step=step;input.placeholder='기존 크기 유지';}else if(type==='text'){input.maxLength=100;input.setAttribute('list','fontFamilies');}
    wrap.append(input);panel.append(wrap);input.onchange=()=>change(read());
  }
  const status=el('p','','tool-help');status.id='designPreviewStatus';status.setAttribute('role','status');panel.append(status);
  const actions=el('div',undefined,'design-actions');panel.append(actions);
  function command(id,label,handler){const button=el('button',label);button.id=id;button.type='button';button.onclick=handler;actions.append(button);return button;}
  const shuffle=command('shuffleDesignBtn','다른 조합',()=>{const choices=[['#ffffff','#172033','#2563eb','Arial'],['#101c27','#e7f0f4','#54ddca','Arial'],['#fff8ee','#362c27','#b94b28','Georgia'],['#f6f3fa','#292135','#7c3aed','Arial'],['#f0f7f2','#183527','#16835a','Georgia'],['#fff5f3','#3b2521','#cb472f','Arial']];const different=choices.filter(v=>v[2]!==draft.colors.accent);const [background,text,accent,font]=different[Math.floor(Math.random()*different.length)];change({...draft,colors:{background,text,accent},fonts:{heading:font,body:'Arial'}});});
  const undo=command('undoDesignBtn','디자인 실행 취소',()=>travel(history,future));
  const redo=command('redoDesignBtn','디자인 다시 실행',()=>travel(future,history));
  const discard=command('discardDesignBtn','미리보기 취소',()=>{if(!original)return;draft=clone(original);history.length=future.length=0;render();preview();});
  const apply=command('applyDesignBtn','이 디자인 적용',action(async()=>{
    if(!context||deck.id!==context.id||deck.revision!==context.revision)throw new Error('자료가 바뀌었습니다. 디자인을 다시 열어 주세요.');
    const next=SDSlides.normalizeTheme(draft);checkpoint();state.theme=next;mark();setPreviewing(false);await flush();context={id:deck.id,revision:deck.revision};original=clone(next);draft=clone(next);history.length=future.length=0;renderSlides();refreshFrame();render();
  }));apply.className='primary';
  function setPreviewing(value){previewing=value;for(const element of [document.querySelector('.slide-rail'),$('canvasViewport'),...document.querySelectorAll('.shell-header-left,.shell-header-title,.shell-header-right,.shell-inspector-nav'),$('notesPanel')])element.inert=value;panel.classList.toggle('design-previewing',value);}
  function read(){
    const theme={colors:{},fonts:{}};for(const key of ['background','text','accent'])theme.colors[key]=controls[key].value;for(const key of ['heading','body'])theme.fonts[key]=controls[key].value;
    for(const key of ['heading','body'])if(controls[key+'Size'].value!==''){theme.sizes??={};theme.sizes[key]=Number(controls[key+'Size'].value);}
    if(controls.radius.value!=='')theme.radius=Number(controls.radius.value);return theme;
  }
  function render(){if(!draft)return;for(const key of ['background','text','accent'])controls[key].value=draft.colors[key];for(const key of ['heading','body']){controls[key].value=draft.fonts[key];controls[key+'Size'].value=draft.sizes?.[key]??'';}controls.radius.value=draft.radius??'';undo.disabled=!history.length;redo.disabled=!future.length;const changed=JSON.stringify(draft)!==JSON.stringify(original);apply.disabled=discard.disabled=!changed;status.textContent=changed?'미리보기 중 · 적용 또는 취소를 선택하세요.':'현재 저장된 디자인';}
  function preview(){post('design-preview',{theme:draft});setPreviewing(JSON.stringify(draft)!==JSON.stringify(original));}
  function change(value){try{const next=SDSlides.normalizeTheme(value);history.push(clone(draft));future.length=0;draft=next;render();preview();}catch(error){status.textContent=error.message;}}
  function travel(from,to){if(!from.length)return;to.push(clone(draft));draft=from.pop();render();preview();}
  async function open(force=true){await settleEditing();await flush();if(!force&&$('inspector-design-tab').getAttribute('aria-selected')!=='true')return;context={id:deck.id,revision:deck.revision};original=SDSlides.normalizeTheme(state.theme);draft=clone(original);history.length=future.length=0;render();SDEditorShell.openPanel('design');}
  top.onclick=action(open);$('inspector-design-tab').addEventListener('click',action(()=>open(false)));
  $('closeInspectorBtn').addEventListener('click',()=>{if(previewing)discard.click();},true);
  document.addEventListener('keydown',event=>{if(!previewing||event.isComposing)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();discard.click();}else if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='z'&&!event.target.matches('input,textarea')){event.preventDefault();event.stopImmediatePropagation();travel(event.shiftKey?future:history,event.shiftKey?history:future);}else{event.stopImmediatePropagation();if((event.ctrlKey||event.metaKey)&&!event.target.matches('input,textarea'))event.preventDefault();}},true);
  const oldDraft=window.authoringHasDraft;window.authoringHasDraft=()=>previewing||oldDraft?.();
})();
