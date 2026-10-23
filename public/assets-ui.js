(() => {
  function node(tag,text,className){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(className)e.className=className;return e;}
  function button(text,fn){const e=node('button',text);e.type='button';e.onclick=fn;return e;}
  function select(label,entries){const e=node('select');e.setAttribute('aria-label',label);for(const [value,text] of entries){const option=node('option',text);option.value=value;e.append(option);}return e;}
  const allowedProviders=new Set(['api.svgl.app','fonts.googleapis.com','fonts.gstatic.com']);
  async function fetchBytes(address,signal,limit=12*1024*1024){
    const url=new URL(address,location.href);
    if(url.origin!==location.origin&&(url.protocol!=='https:'||!allowedProviders.has(url.hostname)))throw new Error('지원하지 않는 자산 제공 주소입니다.');
    const response=await fetch(url,{signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(15000)]),credentials:url.origin===location.origin?'same-origin':'omit',redirect:'error'});
    if(!response.ok)throw new Error(`요청 실패 (${response.status}). 파일을 내려받아 직접 업로드할 수 있습니다.`);
    if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel();throw new Error('가져올 파일이 허용 용량을 넘었습니다.');}
    const reader=response.body.getReader(),chunks=[];let size=0;
    try{while(true){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();throw new Error('가져올 파일이 허용 용량을 넘었습니다.');}chunks.push(value);}}finally{reader.releaseLock();}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return bytes;
  }
  function svgFile(bytes,name){
    const doc=new DOMParser().parseFromString(new TextDecoder().decode(bytes),'image/svg+xml');
    if(doc.querySelector('parsererror')||doc.documentElement.localName!=='svg')throw new Error('올바른 SVG 파일이 아닙니다.');
    if(!doc.documentElement.getAttribute('xmlns'))doc.documentElement.setAttribute('xmlns','http://www.w3.org/2000/svg');
    return new File([new XMLSerializer().serializeToString(doc)],name,{type:'image/svg+xml'});
  }
  function init(options){
    const {api,getDeck,getState,getSelected,getSlideId,insertImage,replaceImage,onNavigate}=options;
    const modal=node('dialog',undefined,'asset-library-dialog');modal.id='assetLibraryDialog';modal.setAttribute('aria-labelledby','assetLibraryTitle');document.body.append(modal);
    let scope='deck',files=[],context,request=0,busy=false,view='grid',fontFace=null,previewRequest=0,onlineController=null;
    const releaseFont=()=>{previewRequest++;if(fontFace){document.fonts.delete(fontFace);fontFace=null;}};
    modal.addEventListener('close',()=>{releaseFont();onlineController?.abort();});
    const header=node('header'),title=node('h2','자산 보관함');title.id='assetLibraryTitle';header.append(title,button('닫기',()=>modal.close()));
    const toolbar=node('div',undefined,'asset-toolbar');
    const scopes=select('자산 위치',[['deck','현재 자료'],['shared','공용 보관함']]);
    const search=node('input');search.type='search';search.placeholder='이름 검색';search.setAttribute('aria-label','자산 이름 검색');
    const kind=select('자산 종류',[['all','모든 자산'],['font','폰트'],['svg+xml','SVG'],['png','PNG'],['jpeg','JPG'],['webp','WebP'],['gif','GIF']]);
    const usage=select('자산 사용 여부',[['all','모든 사용 상태'],['used','사용 중·보호됨'],['unused','삭제 가능한 자산']]);
    const sort=select('자산 정렬',[['name','이름순'],['modified','최근 추가순'],['size','큰 파일순'],['type','종류순']]);
    const layout=button('목록 보기',()=>{view=view==='grid'?'list':'grid';layout.textContent=view==='grid'?'목록 보기':'격자 보기';render();});
    const direction=select('정렬 방향',[['asc','오름차순'],['desc','내림차순']]);const density=node('input');density.type='range';density.min='2';density.max='10';density.value='4';density.setAttribute('aria-label','격자 열 수');density.title='격자 열 수 (2~10)';
    toolbar.append(scopes,search,kind,usage,sort,direction,layout,density);
    const uploads=node('div',undefined,'asset-upload-controls'),input=node('input');input.type='file';input.multiple=true;input.accept='.png,.jpg,.jpeg,.webp,.gif,.svg,.woff,.woff2,.ttf,.otf';input.id='assetFilesInput';input.setAttribute('aria-label','여러 자산 업로드');
    const collision=select('같은 이름 처리',[['rename','같은 이름은 새 이름으로 추가'],['skip','같은 이름은 건너뛰기(취소)']]);uploads.append(input,collision);
    const description=node('p','이미지·SVG·WOFF/WOFF2/TTF/OTF 폰트 · 파일당 12MB(SVG 1MB). 폰트 가져오기는 보관·미리보기이며 슬라이드에 자동 적용하지 않습니다. SVG는 삽입할 때 PNG로 변환합니다. 기존 파일은 덮어쓰지 않습니다. 새 파일을 가져온 뒤 선택한 이미지 교체를 이용하세요.');
    const status=node('p');status.setAttribute('role','status');const error=node('p');error.setAttribute('role','alert');
    const queue=node('ul',undefined,'asset-upload-queue'),body=node('div',undefined,'asset-library-body'),items=node('div',undefined,'asset-items'),detail=node('section',undefined,'asset-detail');detail.hidden=true;body.append(items,detail);
    modal.append(header,toolbar,uploads,description,status,error,queue,body);
    const endpoint=(where=scope)=>where==='shared'?'/asset-library':`/decks/${context.deckId}/asset-library`;
    const active=()=>modal.open&&getDeck()?.id===context?.deckId;
    const guarded=fn=>async()=>{if(busy)return;error.textContent='';try{await fn();}catch(e){error.textContent=e.message;}};
    async function refresh(){const sequence=++request;status.textContent='자산을 불러오는 중…';const data=await api(endpoint());if(!active()||sequence!==request)return;files=data.files.map(file=>scope==='deck'&&JSON.stringify(getState()).includes(file.path)?{...file,canDelete:false,reason:file.canDelete?'현재 편집 중인 이미지입니다. 저장된 버전에서도 보호됩니다.':file.reason}:file);detail.hidden=true;render();}
    function render(){items.className='asset-items '+view;items.style.setProperty('--asset-columns',density.value);density.disabled=view==='list';items.replaceChildren();const visible=files.filter(f=>f.name.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())&&(kind.value==='all'||kind.value==='font'&&f.type.startsWith('font/')||f.type==='image/'+kind.value)&&(usage.value==='all'||(usage.value==='used'?!f.canDelete:f.canDelete))).sort((a,b)=>(direction.value==='desc'?-1:1)*(sort.value==='size'?a.bytes-b.bytes:sort.value==='modified'?a.modifiedAt.localeCompare(b.modifiedAt):sort.value==='type'?a.type.localeCompare(b.type)||a.name.localeCompare(b.name):a.name.localeCompare(b.name)));
      status.textContent=`${visible.length}개 자산 · 전체 ${files.length}개`;if(!visible.length)items.append(node('p','조건에 맞는 자산이 없습니다. 자산 파일을 올리거나 검색 조건을 바꿔 주세요.'));
      for(const file of visible){const card=button('',()=>showDetail(file));card.className='asset-card';card.dataset.path=file.path;card.setAttribute('aria-label',file.name+' 미리보기');const image=file.type.startsWith('font/')?node('span','Aa 가', 'asset-font-tile'):node('img');if(image.tagName==='IMG'){image.src='/api'+endpoint()+'?path='+encodeURIComponent(file.path);image.alt='';image.loading='lazy';}const caption=node('span',file.name);card.append(image,caption,node('small',`${Math.ceil(file.bytes/1024)} KB · ${file.canDelete?'삭제 가능':file.usage.length?'사용 중':'보호됨'}`));items.append(card);}
    }
    async function apply(file,replace){if(!active())throw new Error('자료를 다시 열어 주세요.');const expected={...context,elementId:getSelected()?.id};const selected=getSelected();if(replace&&!(selected?.kind==='image'||selected?.tag==='img'))throw new Error('바꿀 이미지를 먼저 선택해 주세요.');busy=true;
      try{let src=file.path;if(file.type==='image/svg+xml'){const image=new Image();image.src='/api'+endpoint()+'?path='+encodeURIComponent(file.path);await image.decode();const ratio=Math.min(1,2048/Math.max(image.naturalWidth,image.naturalHeight));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*ratio));canvas.height=Math.max(1,Math.round(image.naturalHeight*ratio));canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('SVG를 변환하지 못했습니다. PNG 파일을 직접 업로드해 주세요.');const converted=await api(`/decks/${context.deckId}/asset-library?name=${encodeURIComponent(file.name.replace(/\.svg$/i,'')+'.png')}`,'POST',blob);src=converted.src;}else if(scope==='shared'){const copied=await api(`/decks/${context.deckId}/asset-library?copy=1`,'POST',{fromDeckId:null,path:file.path,collision:'rename'});src=copied.src;}
        if(!active()||getSlideId()!==expected.slideId||replace&&getSelected()?.id!==expected.elementId)throw new Error('편집 대상이 바뀌었습니다. 보관함을 다시 열어 주세요.');
        globalThis.SDObjects.safeImageSource(src);await (replace?replaceImage(src,expected):insertImage(src,expected));modal.close();
      }finally{busy=false;}
    }
    function showDetail(file){releaseFont();detail.replaceChildren();detail.hidden=false;const font=file.type.startsWith('font/');const image=font?node('div','폰트를 불러오는 중…','asset-font-preview'):node('img');if(!font){image.src='/api'+endpoint()+'?path='+encodeURIComponent(file.path);image.alt=file.name;}else{const sequence=previewRequest;const sample=node('textarea');sample.setAttribute('aria-label','폰트 예문');sample.value='다람쥐 헌 쳇바퀴에 타고파 · SDLAB Aa 123';sample.oninput=()=>image.textContent=sample.value;detail.append(sample);fetchBytes('/api'+endpoint()+'?path='+encodeURIComponent(file.path)).then(bytes=>new FontFace('asset-preview-'+sequence,bytes).load()).then(face=>{if(sequence!==previewRequest||!active())return;fontFace=face;document.fonts.add(face);image.style.fontFamily=face.family;image.textContent=sample.value;image.dataset.loaded='true';}).catch(()=>{if(sequence===previewRequest)image.textContent='폰트를 미리 볼 수 없습니다. 올바른 폰트 파일을 확인해 주세요.';});}
      const name=node('input');name.value=file.name;name.maxLength=180;name.setAttribute('aria-label','자산 표시 이름');
      const download=node('a','파일 다운로드');download.href=scope==='deck'?`/api/decks/${context.deckId}/files?path=${encodeURIComponent(file.path)}`:'/api'+endpoint()+'?path='+encodeURIComponent(file.path);download.download=file.name;detail.append(download);
      detail.append(image,name,button('표시 이름 저장',guarded(async()=>{await api(endpoint(),'PATCH',{path:file.path,name:name.value});await refresh();})),node('p',file.reason));
      if(!font)detail.append(button('슬라이드에 삽입',guarded(()=>apply(file,false))));else detail.append(node('p','폰트는 보관·다운로드용입니다. 현재 슬라이드의 글꼴을 바꾸지 않습니다.'));
      const replace=button('선택한 이미지 교체',guarded(()=>apply(file,true)));replace.disabled=!(getSelected()?.kind==='image'||getSelected()?.tag==='img');if(!font)detail.append(replace);
      if(scope==='deck')detail.append(button('공용 보관함에 복사',guarded(async()=>{await api('/asset-library?copy=1','POST',{fromDeckId:context.deckId,path:file.path,collision:'rename'});status.textContent='공용 보관함에 독립된 사본을 저장했습니다.';})));
      if(scope==='shared'&&font)detail.append(button('현재 자료에 복사',guarded(async()=>{if(!active())return;const deckId=context.deckId;busy=true;try{await api(`/decks/${deckId}/asset-library?copy=1`,'POST',{fromDeckId:null,path:file.path,collision:'rename'});if(active()&&context.deckId===deckId){scope='deck';scopes.value='deck';await refresh();status.textContent='현재 자료에 독립된 폰트 사본을 저장했습니다. 슬라이드 글꼴은 바꾸지 않았습니다.';}}finally{busy=false;}})));
      for(const use of file.usage){detail.append(button(`${use.index+1}장 사용 위치로 이동`,guarded(async()=>{if(!active())return;await onNavigate(use.slide);modal.close();})));}
      const remove=button('자산 삭제',guarded(async()=>{if(!file.canDelete)return;await api(endpoint(),'DELETE',{path:file.path});await refresh();}));remove.disabled=!file.canDelete;detail.append(remove,button('미리보기 닫기',()=>{releaseFont();detail.hidden=true;}));
    }
    async function uploadOne(file,row,target){row.replaceChildren(node('span',`${file.name} · 검사 중`));try{if(file.size>12*1024*1024)throw new Error('12MB 이하로 줄여 주세요.');if(!/\.(png|jpe?g|webp|gif|svg|woff2?|ttf|otf)$/i.test(file.name))throw new Error('이미지 또는 WOFF/WOFF2/TTF/OTF 폰트를 선택해 주세요.');row.firstChild.textContent=`${file.name} · 업로드 중`;const result=await api(target+'?name='+encodeURIComponent(file.name)+'&collision='+collision.value,'POST',file);row.firstChild.textContent=`${file.name} · ${result.skipped?'건너뜀 (같은 이름)':`완료 (${result.name})`}`;}catch(e){row.replaceChildren(node('span',`${file.name} · 실패: ${e.message}`),button('이 파일 다시 시도',guarded(async()=>{busy=true;try{await uploadOne(file,row,target);if(active())await refresh();}finally{busy=false;}})));}}
    async function upload(filesToUpload){if(busy||!active())return;const target=endpoint();busy=true;input.disabled=true;scopes.disabled=true;queue.replaceChildren();const jobs=[...filesToUpload].map(file=>{const row=node('li',`${file.name} · 대기`);queue.append(row);return {file,row};});try{for(const {file,row} of jobs){await uploadOne(file,row,target);}if(active())await refresh();}finally{busy=false;input.disabled=false;scopes.disabled=false;input.value='';}}

    const online=node('details',undefined,'asset-online');online.append(node('summary','온라인 로고·폰트 가져오기'));
    online.append(node('p','브라우저가 SVGL 또는 Google Fonts에 직접 연결합니다. 연결이 차단되면 해당 서비스에서 파일을 내려받아 위 업로드로 추가하세요.'));
    const onlineControls=node('div',undefined,'asset-toolbar'),provider=select('온라인 자산 제공자',[['svgl','SVGL 로고'],['google','Google Fonts']]);
    const query=node('input');query.type='search';query.setAttribute('aria-label','온라인 자산 검색');query.placeholder='로고 이름 또는 정확한 Google 폰트 이름';
    const weight=select('가져올 폰트 굵기',Array.from({length:9},(_,i)=>[String((i+1)*100),String((i+1)*100)]));weight.value='400';
    const italic=select('가져올 폰트 스타일',[['0','기본'],['1','기울임']]);weight.hidden=italic.hidden=true;
    provider.onchange=()=>{weight.hidden=italic.hidden=provider.value!=='google';};
    const results=node('div',undefined,'asset-online-results'),cache=new Map();
    const safeName=value=>String(value).replace(/[\\/\x00-\x1f\x7f]/g,'-').slice(0,120)||'asset';
    const externalError=e=>e.name==='AbortError'||e.name==='TimeoutError'?'온라인 요청을 취소했거나 시간이 초과되었습니다. 파일 업로드를 이용할 수 있습니다.':e.message==='Failed to fetch'?'제공 서비스에 연결하지 못했습니다(CORS·네트워크·접근 제한). 파일을 내려받아 직접 업로드해 주세요.':e.message;
    async function takeOnline(url,name,isSvg){
      if(busy||!active())return;busy=true;const target=endpoint(),deckId=context.deckId;onlineController?.abort();onlineController=new AbortController();
      try{status.textContent='온라인 파일을 가져오는 중…';const bytes=await fetchBytes(url,onlineController.signal,isSvg?1024*1024:12*1024*1024);const file=isSvg?svgFile(bytes,name):new File([bytes],name);const result=await api(target+'?name='+encodeURIComponent(file.name)+'&collision='+collision.value,'POST',file);if(active()&&context.deckId===deckId){await refresh();status.textContent=result.skipped?'같은 이름이 있어 가져오기를 건너뛰었습니다.':'가져왔습니다. 보관함에서 미리보기를 열어 주세요.';}}
      catch(e){if(active())error.textContent=externalError(e);}finally{busy=false;}
    }
    const find=button('온라인 검색',guarded(async()=>{
      onlineController?.abort();onlineController=new AbortController();const signal=onlineController.signal;results.replaceChildren();error.textContent='';
      const isGoogle=provider.value==='google',q=query.value.trim(),requestedWeight=weight.value,requestedItalic=italic.value;if(isGoogle&&!/^[\p{L}\p{N} .-]{1,100}$/u.test(q))throw new Error('Google Fonts의 정확한 폰트 이름을 입력해 주세요. 예: Noto Sans KR');
      const address=isGoogle?'https://fonts.googleapis.com/css2?family='+encodeURIComponent(q+':ital,wght@'+requestedItalic+','+requestedWeight):'https://api.svgl.app/?'+(q?'search='+encodeURIComponent(q):'limit=24');
      try{
        let content=cache.get(address);if(!content||Date.now()-content.time>300000){content={time:Date.now(),text:new TextDecoder().decode(await fetchBytes(address,signal,1024*1024))};cache.set(address,content);}if(signal.aborted||!active())return;
        if(isGoogle){
          const choices=[];for(const match of content.text.matchAll(/(?:\/\*\s*([^*]+?)\s*\*\/\s*)?@font-face\s*\{([^}]+)\}/g)){const href=match[2].match(/url\(\s*['"]?(https:\/\/fonts\.gstatic\.com\/[^)'"\s]+)['"]?\s*\)/)?.[1];if(href&&!choices.some(c=>c.url===href))choices.push({url:href,label:match[1]?.trim()||`문자 범위 ${choices.length+1}`});}
          if(!choices.length)throw new Error('이 폰트·굵기·스타일 조합을 찾지 못했습니다. 이름과 지원 스타일을 확인해 주세요.');
          const subset=select('가져올 폰트 문자 범위',choices.map((c,i)=>[String(i),c.label]));const latin=choices.findIndex(c=>c.label==='latin');if(latin>=0)subset.value=String(latin);
          results.append(node('strong',`${q} · ${requestedWeight} · ${requestedItalic==='1'?'기울임':'기본'}`),node('p',`이 폰트는 문자 범위별 ${choices.length}개 파일로 제공됩니다. 선택한 범위의 파일만 보관하며 글꼴을 자동 적용하지 않습니다. 전체 이름 검색은 제공하지 않습니다.`),subset,button('선택한 폰트 파일 가져오기',()=>{const c=choices[Number(subset.value)],ext=new URL(c.url).pathname.match(/\.(woff2?|ttf|otf)$/)?.[1]||'woff2';return takeOnline(c.url,safeName(`${q}-${requestedWeight}${requestedItalic==='1'?'i':''}-${c.label}`)+'.'+ext,false);}));
          const source=node('a','Google Fonts에서 이름과 지원 글자 확인');source.href='https://fonts.google.com/';source.target='_blank';source.rel='noopener noreferrer';results.append(source);
        }else{
          const data=JSON.parse(content.text);if(!Array.isArray(data))throw new Error('로고 검색 결과 형식을 확인할 수 없습니다.');if(!data.length)results.append(node('p','일치하는 로고가 없습니다.'));
          for(const entry of data.slice(0,40)){if(typeof entry.title!=='string')continue;const variants=typeof entry.route==='string'?[['기본',entry.route]]:Object.entries(entry.route||{});const valid=variants.filter(([,route])=>{try{const u=new URL(route);return u.origin==='https://svgl.app'&&/\/[\w.-]+\.svg$/.test(u.pathname);}catch{return false;}});if(!valid.length)continue;const row=node('div',undefined,'asset-online-result'),variant=select(entry.title+' 로고 종류',valid.map(([label],i)=>[String(i),label]));row.append(node('strong',entry.title),variant,button('로고 가져오기',()=>{const [label,route]=valid[Number(variant.value)];const filename=new URL(route).pathname.split('/').at(-1);return takeOnline('https://api.svgl.app/svg/'+encodeURIComponent(filename),safeName(entry.title+'-'+label)+'.svg',true);}));results.append(row);}
        }
      }catch(e){if(active()&&!signal.aborted)error.textContent=externalError(e);}
    }));
    onlineControls.append(provider,query,weight,italic,find);online.append(onlineControls,results);modal.insertBefore(online,body);
    input.onchange=()=>upload(input.files).catch(e=>error.textContent=e.message);
    modal.ondragover=e=>{if(e.dataTransfer.types.includes('Files'))e.preventDefault();};modal.ondrop=e=>{if(e.dataTransfer.files.length){e.preventDefault();upload(e.dataTransfer.files).catch(e=>error.textContent=e.message);}};
    scopes.onchange=guarded(async()=>{scope=scopes.value;queue.replaceChildren();await refresh();});for(const field of [search,kind,usage,sort,direction,density])field.oninput=render;
    async function open(){if(!getDeck()||busy)return;context={deckId:getDeck().id,slideId:getSlideId()};scope=scopes.value;queue.replaceChildren();error.textContent='';modal.showModal();await refresh();search.focus();}
    document.getElementById('assetsBtn')?.addEventListener('click',()=>open().catch(e=>error.textContent=e.message));
    return {open};
  }
  globalThis.SDAssets={init};
})();
