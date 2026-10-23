(() => {
  function button(parent,id,label,handler){const b=el('button',label);b.id=id;b.onclick=handler;parent.append(b);return b;}
  function field(parent,label,type='text',value=''){const wrap=el('label',label), input=el('input');input.type=type;input.value=value;wrap.append(input);parent.append(wrap);return input;}
  function check(parent,label,value=false){const wrap=el('label'),input=el('input');input.type='checkbox';input.checked=value;wrap.append(input,document.createTextNode(label));parent.append(wrap);return input;}
  function form(title){const body=dialog(title);body.classList.add('workflow-form');return body;}
  async function adopted(d){deck=d;state=clone(d.state);dirty=false;blocked=false;undo=[];redo=[];index=Math.min(index,state.order.length-1);renderSlides();refreshFrame();$('saveStatus').textContent=`저장됨 · v${d.revision}`;}
  async function saveMutation(path, data) {
    const context={id:deck.id,epoch:editEpoch};
    const result=await api(path,'POST',data);
    if(deck?.id!==context.id) { toast('요청한 자료에 변경을 저장했습니다. 현재 열린 자료는 유지합니다.'); return false; }
    if(editEpoch!==context.epoch) {
      blocked=true;dirty=true;clearTimeout(saveTimer);$('saveStatus').textContent='저장 충돌 · 내 변경 보존 중';conflictDialog();
      throw new Error('처리 중 새로 입력한 내용은 보존했습니다. 최신 저장본과 내 변경을 확인해 주세요.');
    }
    $('dialog').close();await adopted(result);return true;
  }
  $('settingsBtn').onclick=()=>{
    const body=form('설정');button(body,'aiConnectionBtn','AI 연결',()=>{ $('dialog').close();SDAIConnection.open();});
    button(body,'settingsPasswordBtn','로그인 비밀번호 변경',()=>{$('dialog').close();$('passwordBtn').click();});
  };
  
  const design=$('ribbon-slide'),file=$('ribbon-file'),present=$('ribbon-present');
  button(present,'startPresenterBtn','발표자 화면 시작',()=> $('previewBtn').click());
  button(present,'preflightBtn','발표 전 점검',action(async()=>{
    await flush();SDPreflight.open({frame,origin:new URL(deck.previewUrl).origin,onSelect(issue){
      const i=Number.isInteger(issue.index)?issue.index:state.order.indexOf(issue.slide);if(i>=0){index=i;post('go',{index});renderSlides();renderLayers();if(issue.id)post('select-ids',{ids:[issue.id]});}
    }});
  }));
  $('previewBtn').onclick=()=>{
    const reserved=SDPresenter.reserve();
    action(async()=>{await flush();SDPresenter.open({...deck,state},index,reserved);})().catch?.(()=>reserved?.close());
  };
  button(file,'deckInfoBtn','자료 정보',()=>{
    const body=form('자료 정보');for(const [name,value]of [['최초 업로드',deck.createdAt],['마지막 수정',deck.updatedAt],['현재 버전 저장',deck.savedAt],['공유 게시',deck.publishedAt]])body.append(el('p',`${name}: ${SDTime.format(value,true)}`));
    body.append(el('p',`편집 v${deck.revision} · 공유 ${deck.publishedRevision?`v${deck.publishedRevision}`:'없음'}`));
  });
  $('versionsBtn').onclick=action(async()=>{
    await flush();const rows=await api(`/decks/${deck.id}/revisions`),body=form('저장 버전');
    body.append(el('p','최신순 · 모든 시각은 한국 시간(KST)입니다. 복원하면 현재 기록을 남기고 새 버전을 만듭니다.'));
    function row(r,parent){
      const box=el('div',undefined,'version-row');box.append(el('span',`v${r.revision} · ${SDTime.format(r.savedAt,true)}${r.source?` · ${{manual:'수동 편집',ai:'AI 수정',restore:'복원',import:'가져오기',template:'템플릿',brand:'브랜드 적용'}[r.source]||r.source}`:''}${r.summary?` · ${r.summary}`:''}`));
      const name=el('input');name.value=r.name||'';name.placeholder='중요한 버전 이름';name.maxLength=100;name.setAttribute('aria-label',`v${r.revision} 이름`);box.append(name);
      button(box,`nameRevision${r.revision}`,'이름 저장',action(async()=>{await api(`/decks/${deck.id}/revision-name`,'POST',{revision:r.revision,name:name.value});toast('버전 이름을 저장했습니다.');}));
      const restore=button(box,`restoreRevision${r.revision}`,r.revision===deck.revision?'현재 버전':'복원',action(async()=>{if(!await saveMutation(`/decks/${deck.id}/restore`,{revision:deck.revision,target:r.revision}))return;toast('이전 버전을 새 저장본으로 복원했습니다.');}));restore.disabled=r.revision===deck.revision;parent.append(box);
    }
    for(let i=0;i<rows.length;){const start=i,first=rows[i];i++;
      if(first.summary==='자동 저장'&&!first.name)while(i<rows.length&&rows[i].summary==='자동 저장'&&!rows[i].name&&new Date(first.savedAt)-new Date(rows[i].savedAt)<5*60*1000)i++;
      if(i-start>1){const details=el('details');details.append(el('summary',`자동 저장 ${i-start}개 · v${first.revision}–v${rows[i-1].revision} · ${SDTime.format(first.savedAt,true)}`));for(const r of rows.slice(start,i))row(r,details);body.append(details);}else row(first,body);
    }
  });
  $('shareBtn').onclick=action(async()=>{
    await flush();const body=form('발표 자료 공유');body.append(el('p','현재 저장본을 게시합니다. 새 공유본은 발표자 노트를 기본 제외하며, 이후 편집은 다시 게시할 때 반영됩니다.'));
    if(deck.shareUrl){const link=field(body,'공유 링크','text',deck.shareUrl);link.readOnly=true;link.onclick=()=>link.select();
      body.append(el('p',`게시 v${deck.publishedRevision} · ${SDTime.format(deck.publishedAt,true)} · 편집 v${deck.revision}${deck.publishedRevision!==deck.revision?' — 아직 공유하지 않은 변경이 있습니다.':''}`));
      if(deck.shareLegacyNotes)body.append(el('p','기존 링크는 이전 노트 포함 정책을 유지합니다. 노트를 제외해 다시 게시하면 같은 링크의 제공 내용이 바뀝니다.'));
      if(deck.sharePasswordProtected)body.append(el('p','접근 암호가 설정되어 있습니다. 아래를 비우면 기존 암호를 유지합니다.'));
    }
    const notes=check(body,'발표자 노트도 공유하기 (공유받은 사람이 읽을 수 있습니다)',!!deck.shareUrl&&(deck.shareIncludeNotes===true||deck.shareLegacyNotes===true));
    const expiration=field(body,'링크 만료일시 (한국 시간 KST)','datetime-local',deck.shareExpiresAt?SDTime.format(deck.shareExpiresAt).replace(' ','T'):'');
    const password=field(body,'접근 암호 (선택)','password');password.autocomplete='new-password';password.maxLength=128;
    const removePassword=check(body,'기존 접근 암호 해제');
    button(body,'publishShareBtn',deck.shareUrl?'이 설정으로 다시 게시':'공유 링크 만들기',action(async()=>{
      const expiresAt=expiration.value?new Date(expiration.value+':00+09:00').toISOString():null;
      const options={enabled:true,includeNotes:notes.checked,expiresAt};if(password.value)options.password=password.value;else if(removePassword.checked)options.password=null;
      deck={...deck,...await api(`/decks/${deck.id}/publish`,'POST',options)};password.value='';$('dialog').close();$('shareBtn').click();
    })).className='primary';
    if(deck.shareUrl)button(body,'stopShareBtn','공유 종료',action(async()=>{deck={...deck,...await api(`/decks/${deck.id}/publish`,'POST',{enabled:false})};$('dialog').close();toast('공유 링크와 자산 접근을 종료했습니다.');}));
  });
  button(file,'aiChangesBtn','AI 변경 검토',action(async()=>{
    await flush();const entries=await api(`/decks/${deck.id}/proposals`),body=form('AI 변경 검토');body.append(el('p','AI 변경안은 적용하기 전까지 현재 저장본을 바꾸지 않습니다.'));
    const list=Array.isArray(entries)?entries:entries.proposals;
    if(!list.length)body.append(el('p','대기 중인 변경안이 없습니다. 설정 → AI 연결의 프롬프트로 수정을 요청하세요.'));
    for(const entry of list)button(body,`proposal-${entry.id}`,`${entry.summary||'AI 변경안'} · 기준 v${entry.baseRevision} · ${entry.status||'대기'}`,action(()=>compare(entry.id)));
  }));
  async function compare(id){
    const proposal=await api(`/decks/${deck.id}/proposals/${id}`),body=form('AI 수정 전후 비교');
    body.append(el('p',`기준 v${proposal.baseRevision} · 현재 v${deck.revision} · ${proposal.summary||''}`));
    if(proposal.baseRevision!==deck.revision)body.append(el('p','다른 편집이 저장되었습니다. 최신 상태로 AI에 다시 요청하세요. 이 변경안은 덮어쓸 수 없습니다.'));
    const comparison=el('div',undefined,'comparison');const frames=[],emptyViews=[];
    for(const [label,url]of [['수정 전',proposal.beforeUrl],['수정 후',proposal.afterUrl]]){const col=el('div');col.append(el('h3',label));const f=el('iframe');f.title=label;f.setAttribute('sandbox','allow-scripts allow-same-origin');f.dataset.slideIndex='0';f.onload=()=>f.contentWindow.postMessage({studio:true,type:'present-go',index:Number(f.dataset.slideIndex)},new URL(url).origin);f.src=url;col.append(f);const empty=el('p','이 버전에는 해당 슬라이드가 없습니다.');empty.hidden=true;col.append(empty);emptyViews.push(empty);frames.push(f);comparison.append(col);}body.append(comparison);
    const choices=[];
    for(const change of proposal.changes){const row=el('div',undefined,'change-row');const n=state.order.indexOf(change.slide);const input=check(row,change.slide==='__global__'?'공통 디자인·슬라이드 구성 변경':`슬라이드 ${n>=0?n+1:change.slide} 변경`,true);input.dataset.slide=change.slide;choices.push(input);
      button(row,'','이 장 비교',()=>{for(let i=0;i<frames.length;i++){const order=i?proposal.state.order:(proposal.beforeOrder||state.order);const position=change.slide==='__global__'?0:order.indexOf(change.slide);frames[i].hidden=position<0;emptyViews[i].hidden=position>=0;if(position>=0){const url=new URL(i?proposal.afterUrl:proposal.beforeUrl);url.hash=String(position+1);frames[i].dataset.slideIndex=String(position);frames[i].src=url.href;frames[i].contentWindow.postMessage({studio:true,type:'present-go',index:position},url.origin);}}});
      row.append(el('pre',`이전: ${change.beforeText||'(텍스트 없음)'}\n이후: ${change.afterText||'(텍스트 없음)'}`));body.append(row);
    }
    const apply=button(body,'applyAIChangesBtn','선택한 변경 적용',action(async()=>{const slides=choices.filter(c=>c.checked).map(c=>c.dataset.slide);if(!slides.length)throw new Error('적용할 변경을 선택하세요.');try{if(!await saveMutation(`/decks/${deck.id}/proposals/${id}/apply`,{revision:deck.revision,slides}))return;toast('AI 변경을 새 버전으로 저장했습니다. 버전에서 이전 상태로 복원할 수 있습니다.');}catch(e){if(e.status===409){body.append(el('p','최신 저장본이 바뀌었습니다. 창을 닫고 자료를 다시 연 뒤 변경안을 새로 요청하세요.'));apply.disabled=true;}throw e;}}));
    apply.disabled=proposal.baseRevision!==deck.revision||!['pending',undefined].includes(proposal.status);
    button(body,'rejectAIChangesBtn','변경안 취소',action(async()=>{await api(`/decks/${deck.id}/proposals/${id}/reject`,'POST',{});$('dialog').close();toast('현재 저장본을 유지하고 변경안을 취소했습니다.');}));
  }
  async function templates(){
    if(deck)await flush();const values=await api('/templates'),body=form('템플릿으로 만들기');body.append(el('p','선택한 구성을 독립된 새 자료로 만듭니다. 현재 자료의 내용은 그대로 보존됩니다.'));const grid=el('div',undefined,'template-grid');
    for(const item of (Array.isArray(values)?values:values.templates))button(grid,`template-${item.id}`,item.name||item.title,action(async()=>{
      const preview=form('새 자료 만들기 확인');preview.append(el('h3',item.name||item.title),el('p',item.description||'슬라이드 구성과 필요한 이미지·글꼴을 독립적으로 복사합니다.'));
      if(item.previewUrl){const f=el('iframe');f.title='템플릿 미리보기';f.src=item.previewUrl;f.setAttribute('sandbox','allow-scripts allow-same-origin');f.style.cssText='width:100%;aspect-ratio:16/9';preview.append(f);}
      button(preview,'createFromTemplateBtn','이 템플릿으로 새 자료 만들기',action(async()=>{const d=await api(`/templates/${item.id}/create`,'POST',{});$('dialog').close();await openDeck(d.id);}));
    }));body.append(grid);
  }
  button(design,'templatesBtn','템플릿',action(templates));button($('newBtn').parentElement,'libraryTemplatesBtn','템플릿으로 만들기',action(templates));
  button(design,'saveTemplateBtn','현재 자료를 템플릿으로 저장',action(async()=>{await flush();const body=form('재사용할 템플릿 저장'),name=field(body,'템플릿 이름','text',deck.title);button(body,'confirmSaveTemplateBtn','템플릿 저장',action(async()=>{await api('/templates','POST',{deckId:deck.id,name:name.value});$('dialog').close();toast('자산을 함께 복사한 독립 템플릿을 저장했습니다.');}));}));
  button(design,'brandsBtn','브랜드',action(async()=>{
    await flush();const body=form('브랜드 색상·글꼴·로고'),brands=await api('/brands');
    const list=el('div',undefined,'actions');for(const brand of (Array.isArray(brands)?brands:brands.brands))button(list,`brand-${brand.id}`,`${brand.name} 적용`,action(async()=>{if(!await saveMutation(`/brands/${brand.id}/apply`,{deckId:deck.id,revision:deck.revision}))return;toast('브랜드를 적용했습니다. 이전 내용은 버전에서 복원할 수 있습니다.');}));body.append(list);
    body.append(el('p','공통 테마를 사용하는 글과 배경에 적용합니다. 개별 지정한 서식은 유지합니다. 로고는 자료에서 고른 이미지 파일을 독립 복사합니다.'));
    const name=field(body,'브랜드 이름'),colors={};for(const [key,label,fallback]of [['background','배경색','#ffffff'],['text','본문색','#172033'],['accent','강조색','#2563eb']])colors[key]=field(body,label,'color',state.theme?.colors?.[key]||fallback);
    const font=field(body,'글꼴','text',state.theme?.fonts?.body||'Arial');const assets=await api(`/decks/${deck.id}/files`);const logo=el('select');logo.setAttribute('aria-label','로고 이미지');const none=el('option','로고 없음');none.value='';logo.append(none);for(const asset of assets.files.filter(f=>/\.(png|jpg|jpeg|webp|gif)$/i.test(f.path))){const option=el('option',asset.path);option.value=asset.path;logo.append(option);}body.append(logo);
    button(body,'saveBrandBtn','브랜드 저장',action(async()=>{await api('/brands','POST',{name:name.value,colors:Object.fromEntries(Object.entries(colors).map(([k,v])=>[k,v.value])),font:font.value,deckId:deck.id,...(logo.value?{logo:logo.value}:{})});$('dialog').close();toast('브랜드를 저장했습니다.');}));
  }));
})();
