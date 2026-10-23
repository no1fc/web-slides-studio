(() => {
  'use strict';
  const prefix = 'sd-presenter-';
  const put = (target, id, data) => target.sessionStorage.setItem(prefix + id, JSON.stringify(data));
  window.SDPresenter = {
    reserve() { return window.open('about:blank', '_blank', 'popup,width=1280,height=800'); },
    open(deck, index = 0, reserved) {
      const id = crypto.randomUUID();
      if (!deck.audienceUrl) { reserved?.close(); throw new Error('청중 전용 주소를 받지 못했습니다. 편집기를 새로고침한 뒤 발표를 다시 시작하세요.'); }
      const url = new URL(deck.audienceUrl);
      url.searchParams.set('mode', 'audience'); url.searchParams.set('presentView', '1');
      const sourceNotes = {...deck.sourceNotes};
      for (const [copy, source] of Object.entries(deck.state?.clones || {})) sourceNotes[copy] = sourceNotes[source] || '';
      const slides = (deck.state?.order || deck.slides.map(slide=>slide.id)).map(id=>({id}));
      const data = {id, title:deck.title, url:url.href, index, slides, notes:{...sourceNotes,...deck.state?.notes}, deckId:deck.id};
      const target = reserved && !reserved.closed ? reserved : null;
      if (target) {
        try { put(target,id,data); target.location.replace('/presenter.html?session=' + id); target.focus(); return target; }
        catch { target.close(); }
      }
      put(window,id,data);
      location.assign('/presenter.html?session=' + id);
      return null;
    },
  };
  if (!document.body.classList.contains('presenter-page')) return;
  const $ = id => document.getElementById(id);
  const id = new URLSearchParams(location.search).get('session');
  let data;
  try { data = JSON.parse(sessionStorage.getItem(prefix + id)); } catch {}
  sessionStorage.removeItem(prefix + id);
  if (!data || data.id !== id || !Array.isArray(data.slides) || !/^https?:$/.test(new URL(data.url).protocol)) {
    $('presentStatus').textContent = '발표 세션이 종료되었습니다. 편집기에서 발표를 다시 시작하세요.';
    $('presentLayout').hidden = true;
    document.querySelectorAll('button').forEach(button => button.disabled = true);
    return;
  }
  const isAudience = data.audience === true;
  const contentOrigin = new URL(data.url).origin;
  const channel = new BroadcastChannel(prefix + id);
  let index = Math.max(0,Math.min(data.slides.length - 1, data.index || 0));
  let black = !!data.black, laser = !!data.laser, started = Date.now(), audienceWindow;
  let singleScreen = false, currentReady = false;
  const current = $('currentSlide'), next = $('nextSlide');
  document.title = `${data.title || 'SDLAB Slides'} · ${isAudience ? '청중 화면' : '발표자 화면'}`;
  $('presentTitle').textContent = data.title || '발표자 화면';
  $('returnEditor').href = '/#deck=' + encodeURIComponent(data.deckId || '');
  // Notes never cross the presentation channel or enter the audience session.
  if (isAudience) { document.body.classList.add('audience-only'); $('presentNotes').remove(); document.querySelector('.notes').remove(); }
  const send = (frame, message) => frame.contentWindow?.postMessage({studio:true,...message}, contentOrigin);
  const publish = () => channel.postMessage({type:'state', index, black, laser});
  const render = (navigate = true) => {
    if (navigate) send(current,{type:'present-go',index});
    send(current,{type:'present-state',black,laser});
    if (!isAudience) {
      if (navigate) send(next,{type:'present-go',index:Math.min(data.slides.length-1,index+1)});
      $('slideCount').textContent = `${index + 1} / ${data.slides.length}`;
      $('presentNotes').textContent = data.notes?.[data.slides[index]?.id] || '이 슬라이드에는 노트가 없습니다.';
      $('previousSlide').disabled = index === 0;
      $('nextButton').disabled = index === data.slides.length-1;
      next.hidden = index === data.slides.length-1;
      $('lastSlide').hidden = !next.hidden;
      $('blackScreen').setAttribute('aria-pressed',String(black));
      $('laserPointer').setAttribute('aria-pressed',String(laser));
    }
  };
  const move = value => { index = Math.max(0,Math.min(data.slides.length-1,value)); render(); publish(); };
  const state = message => {
    const previousIndex = index;
    if (Number.isInteger(message.index)) index = Math.max(0,Math.min(data.slides.length-1,message.index));
    if (typeof message.black === 'boolean') black = message.black;
    if (typeof message.laser === 'boolean') laser = message.laser;
    render(previousIndex !== index);
    if (Number.isFinite(message.x) && Number.isFinite(message.y)) send(current,{type:'present-state',black,laser,x:message.x,y:message.y});
  };
  channel.onmessage = event => {
    if (event.data?.type === 'state') state(event.data);
    if (event.data?.type === 'ready' && !isAudience) publish();
  };
  addEventListener('message', event => {
    if (event.origin !== contentOrigin || !event.data?.studio) return;
    if (event.source === current.contentWindow) {
      if (event.data.type === 'navigate' && currentReady && event.data.index !== index) move(event.data.index);
      if (event.data.type === 'ready') { currentReady = true; render(); }
      if (event.data.type === 'present-state') { state(event.data); channel.postMessage({type:'state',index,black,laser,x:event.data.x,y:event.data.y}); }
    } else if (event.source === next.contentWindow && event.data.type === 'ready') render();
  });
  const urlAt = n => { const url = new URL(data.url); url.hash = String(n+1); return url.href; };
  current.src = urlAt(index);
  if (!isAudience) next.src = urlAt(Math.min(data.slides.length-1,index+1));
  $('previousSlide').onclick = () => move(index-1);
  $('nextButton').onclick = () => move(index+1);
  $('blackScreen').onclick = () => { black = !black; render(false); publish(); };
  $('laserPointer').onclick = () => { laser = !laser; render(false); publish(); };
  $('fullScreen').onclick = async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen(); }
    catch { $('presentStatus').textContent = '전체 화면을 사용할 수 없습니다. 브라우저의 전체 화면 기능을 사용하세요.'; }
  };
  $('resetTimer').onclick = () => { started = Date.now(); $('elapsed').textContent = '00:00'; };
  const timer = setInterval(() => {
    const seconds = Math.floor((Date.now()-started)/1000);
    $('elapsed').textContent = `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`;
  },1000);
  $('openAudience').onclick = () => {
    if (audienceWindow && !audienceWindow.closed) { audienceWindow.focus(); publish(); return; }
    audienceWindow = window.open('about:blank','_blank','popup,width=1280,height=720');
    if (!audienceWindow) { $('presentStatus').textContent = '팝업이 차단되었습니다. 이 사이트의 팝업을 허용하거나 ‘이 화면으로 발표’를 사용하세요. 노트는 발표 중 숨겨집니다.'; return; }
    put(audienceWindow,id,{id,audience:true,title:data.title,url:data.url,index,slides:data.slides.map(slide=>({id:slide.id})),black,laser});
    audienceWindow.opener = null;
    audienceWindow.location.replace('/presenter.html?session='+id);
  };
  const leaveSingle = () => { singleScreen = false; document.body.classList.remove('audience-only'); $('singleScreen').focus(); };
  $('singleScreen').onclick = () => { singleScreen = true; document.body.classList.add('audience-only'); current.focus(); };
  addEventListener('keydown', event => {
    if (event.isComposing || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape' && singleScreen) { leaveSingle(); return; }
    if (event.target instanceof Element && (event.target.isContentEditable || event.target.closest('input,textarea,select,button,a,[role="link"]'))) return;
    if (['ArrowRight','ArrowDown','PageDown',' ','ArrowLeft','ArrowUp','PageUp','Home','End','b','B','l','L'].includes(event.key)) {
      event.preventDefault();
      if (event.key.toLowerCase() === 'b') { black=!black;render(false);publish(); }
      else if (event.key.toLowerCase() === 'l') { laser=!laser;render(false);publish(); }
      else if (event.key === 'Home') move(0);
      else if (event.key === 'End') move(data.slides.length-1);
      else move(index+(['ArrowLeft','ArrowUp','PageUp'].includes(event.key)||event.key===' '&&event.shiftKey?-1:1));
    }
  });
  // Escape originating inside the slide iframe also returns the single-screen presenter.
  addEventListener('message', event => { if (event.origin === contentOrigin && event.source === current.contentWindow && event.data?.studio && event.data.type === 'present-escape' && singleScreen) leaveSingle(); });
  addEventListener('pagehide', () => { clearInterval(timer); channel.close(); });
  render(); channel.postMessage({type:'ready'});
})();
