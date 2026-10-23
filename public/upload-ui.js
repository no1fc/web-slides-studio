(() => {
  const queue = [], completed = new Map(); let running = false;
  const labels = {waiting:'대기',checking:'검사 중',review:'변환 확인 필요',uploading:'업로드 중',done:'완료',error:'실패',duplicate:'중복 확인 필요'};
  const panel=el('section',undefined,'upload-queue'); panel.id='uploadQueue'; panel.hidden=true;panel.setAttribute('aria-label','가져오기 진행 상태');
  $('library').querySelector('.library-tools').after(panel);
  function render(){
    panel.hidden=!queue.length;panel.replaceChildren(el('h2','자료 가져오기'));
    const list=el('div');list.setAttribute('aria-live','polite');
    for(const item of queue){
      const row=el('div',undefined,'upload-row');row.dataset.status=item.status;
      const info=el('div');info.append(el('strong',item.file.name),el('p',`${labels[item.status]}${item.message?' · '+item.message:''}`));row.append(info);
      if(item.status==='error') {const retry=el('button','이 파일 다시 시도');retry.onclick=()=>{item.status='waiting';item.message='';void run();};row.append(retry);}
      if(item.status==='review'){const accept=el('button','변환 결과 가져오기');accept.onclick=()=>{item.accepted=true;item.status='waiting';void run();};row.append(accept);}
      if(item.status==='duplicate'){const retry=el('button','중복 확인 후 계속');retry.onclick=()=>{item.allowDuplicate=true;item.status='waiting';void run();};row.append(retry);}
      if(item.result){const open=el('button','자료 열기');open.onclick=action(()=>openDeck(item.result.id));row.append(open);}
      list.append(row);
    }
    panel.append(list);
  }
  async function check(item){
    const file=item.file,format=/\.pptx$/i.test(file.name)?'pptx':/\.zip$/i.test(file.name)?'zip':null;
    if(!format)throw new Error('지원하지 않는 파일입니다. HTML 발표는 ZIP으로, PowerPoint는 .pptx로 저장해 주세요.');
    if(file.size>40*1024*1024)throw new Error('파일이 40 MiB를 넘습니다. 큰 이미지·동영상을 줄여 주세요.');
    const bytes=new Uint8Array(await file.arrayBuffer());const listing=SDUploadCheck.directory(bytes,format);
    item.key=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
    item.format=format;
    if(format==='pptx'&&!listing.files.includes('ppt/presentation.xml'))throw new Error('올바른 PowerPoint 발표 구조가 없습니다. PowerPoint에서 PPTX로 다시 저장해 주세요.');
    const previous=queue.find(other=>other!==item&&other.key===item.key&&other.status==='done');
    const existing=decks.find(d=>!d.deleted&&d.importKey===item.key);
    if(!item.allowDuplicate&&(previous||completed.has(item.key)||existing)){item.status='duplicate';item.message='같은 내용의 파일을 이미 가져왔습니다. 자료실의 복제로 독립 사본을 만들 수도 있습니다.';item.result=previous?.result||completed.get(item.key)||existing;return;}
    if(format==='pptx'){
      if(!item.accepted){const report=await api('/import-pptx','POST',file);item.status='review';item.message=`${report.counts.slides}장 · ${report.warnings.map(w=>w.message).join(' / ')||'감지된 변환 경고 없음'}. 원본 외형·효과는 가져온 후 확인하세요.`;return;}
    }else{
      const candidates=listing.files.filter(n=>n==='index.html'||n.endsWith('/index.html'));
      const entry=listing.files.includes('index.html')?'index.html':candidates.length===1?candidates[0]:null;
      if(!entry)throw new Error('시작 화면(index.html)을 찾을 수 없습니다. 발표 폴더와 이미지·글꼴을 함께 압축해 주세요.');
      const zip=await JSZip.loadAsync(bytes);const source=await SDUploadCheck.text(zip.file(entry));
      const doc=new DOMParser().parseFromString(source,'text/html');
      let slides=doc.querySelectorAll('.slide');if(!slides.length)slides=doc.querySelectorAll('section');
      if(!slides.length||slides.length>80)throw new Error('슬라이드 구성을 인식하지 못했거나 80장을 넘습니다. .slide 또는 같은 부모 아래 section으로 구성한 발표를 사용해 주세요.');
      if([...slides].some(slide=>slide.parentElement!==slides[0].parentElement))throw new Error('슬라이드는 같은 부모 아래 나란히 있어야 합니다. 슬라이드 안의 슬라이드나 다른 영역에 놓인 장을 정리해 주세요.');
      const prefix=entry.slice(0,-10), root=new URL('https://package.invalid/'+prefix);
      const refs=[...doc.querySelectorAll('[src],link[href]')].map(e=>e.getAttribute('src')||e.getAttribute('href'));
      for(const m of source.matchAll(/url\(\s*['"]?([^'"\)]+)['"]?\s*\)/g))refs.push(m[1]);
      const missing=refs.filter(ref=>ref&&!/^(?:#|data:|https?:|blob:)/i.test(ref)).filter(ref=>{try{return !listing.files.includes(decodeURIComponent(new URL(ref,root).pathname.slice(1)));}catch{return true;}});
      if(missing.length)throw new Error(`이미지·글꼴 등 필요한 파일이 빠졌습니다: ${missing.slice(0,5).join(', ')}. 해당 파일을 발표 폴더에 넣고 다시 압축해 주세요.`);
    }
  }
  async function run(){
    if(running)return;running=true;
    try{
      for(const item of queue){
        if(item.status!=='waiting')continue;
        try{
          item.status='checking';render();await check(item);
          if(['review','duplicate'].includes(item.status)){render();continue;}
          item.status='uploading';item.message='서버에서 검증하고 자료를 저장합니다.';render();
          const response=await fetch('/api'+(item.format==='pptx'?'/import-pptx?confirm=1':'/decks'),{method:'POST',headers:{'Content-Type':'application/zip','X-Import-Key':item.key},body:item.file});
          const result=await response.json();if(!response.ok)throw new Error(result.error||'서버에 연결하지 못했습니다. 연결을 확인한 뒤 이 파일만 다시 시도하세요.');
          item.result=result;item.status='done';item.message='자료실에 저장되었습니다.';completed.set(item.key,result);
        }catch(error){item.status='error';item.message=error.message;}
        render();
      }
      decks=await api('/decks');renderLibrary();
    }catch(error){toast(error.message);}finally{running=false;render();if(queue.some(item=>item.status==='waiting'))void run();}
  }
  function enqueue(files){for(const file of files)queue.push({file,status:'waiting',message:''});render();void run();}
  for(const id of ['zipInput','pptxInput']){$(id).multiple=true;$(id).accept='.zip,.pptx';$(id).onchange=event=>{enqueue([...event.target.files]);event.target.value='';};}
  const target=$('library');
  target.addEventListener('dragover',event=>{if(event.dataTransfer.types.includes('Files')){event.preventDefault();target.classList.add('drop-active');}});
  target.addEventListener('dragleave',event=>{if(!target.contains(event.relatedTarget))target.classList.remove('drop-active');});
  target.addEventListener('drop',event=>{event.preventDefault();target.classList.remove('drop-active');enqueue([...event.dataTransfer.files]);});
  globalThis.SDUpload={enqueue};
})();
