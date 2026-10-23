(() => {
  'use strict';
  let navigate;
  // Register before imported scripts so their keyboard handlers cannot advance a second time.
  addEventListener('keydown', event => navigate?.(event), true);
  window.SDPresentation = {
    attach(slides, go, getCurrent) {
      if (!slides.length) return;
      let clean = false;
      const audience = new URLSearchParams(location.search).get('presentView') === '1';
      const config = JSON.parse(document.getElementById('sd-config')?.textContent || '{}');
      let black = false, laser = false;
      const notify = (data) => {
        const managerOrigin = config.managerOrigin;
        if (parent !== window && managerOrigin) parent.postMessage({studio:true, type:'present-state', ...data}, managerOrigin);
      };
      let stage = slides[0].parentElement;
      if (stage === document.body) {
        stage = document.createElement('div');
        slides[0].before(stage);
        slides.forEach(slide => stage.append(slide));
      }
      const set = (element, rules) => {
        for (const [key, value] of Object.entries(rules)) element.style.setProperty(key, value, 'important');
      };
      const originalDisplay = new Map(slides.map(slide => [slide, [slide.style.getPropertyValue('display'), slide.style.getPropertyPriority('display')]]));
      set(document.documentElement, {overflow:'hidden', width:'100%', height:'100%'});
      set(document.body, {overflow:'hidden', margin:'0', width:'100%', height:'100%'});
      set(stage, {position:'fixed', width:'1920px', height:'1080px', 'min-width':'0', 'min-height':'0', 'max-width':'none', 'max-height':'none', margin:'0', padding:'0', border:'0', 'box-sizing':'border-box', 'transform-origin':'0 0', display:'block'});
      for (const slide of slides) set(slide, {position:'absolute', inset:'0', width:'1920px', height:'1080px', 'min-width':'0', 'min-height':'0', 'max-width':'none', 'max-height':'none', margin:'0', 'box-sizing':'border-box', transform:'none'});
      const style = document.createElement('style');
      style.textContent = `
        #hud,#help,#progress,#notes,.notes{display:none!important}
        #sd-shared-notes:not([hidden]){display:block!important}
        #sd-shared-notes[hidden]{display:none!important}
        #sd-presentation-controls{position:fixed!important;inset:auto 0 0!important;height:56px!important;display:flex!important;align-items:center!important;justify-content:center!important;gap:12px!important;background:#17202a!important;color:white!important;z-index:2147483647!important;font:16px system-ui!important;transform:none!important}
        #sd-presentation-controls button{position:static!important;width:auto!important;height:36px!important;margin:0!important;padding:0 14px!important;border:1px solid #8b98a5!important;border-radius:6px!important;background:#273746!important;color:white!important;font:inherit!important;cursor:pointer!important}
        #sd-presentation-controls button:disabled{opacity:.45!important;cursor:default!important}
        #sd-presentation-controls button:focus-visible{outline:3px solid #73e1d4!important;outline-offset:2px!important}
        #sd-presentation-controls output{position:static!important;min-width:64px!important;text-align:center!important}
      `;
      document.head.append(style);
      const controls = document.createElement('nav');
      controls.id = 'sd-presentation-controls';
      controls.setAttribute('aria-label', '발표 제어');
      controls.innerHTML = '<button type="button" aria-label="이전 슬라이드">← 이전</button><output aria-live="polite" aria-label="현재 슬라이드"></output><button type="button" aria-label="다음 슬라이드">다음 →</button><button type="button" aria-label="전체 화면">전체 화면</button>';
      if (!audience && Number.isInteger(config.publishedRevision) && config.publishedRevision > 0) {
        const publication = document.createElement('small');
        publication.id = 'sd-publication-info';
        publication.setAttribute('aria-label', '공유 게시 정보');
        const date = config.publishedAt ? new Date(config.publishedAt) : null;
        let timestamp = '기록 없음';
        if (date && Number.isFinite(date.getTime())) {
          const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'}).formatToParts(date).map(part => [part.type, part.value]));
          timestamp = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} (KST)`;
        }
        publication.textContent = `공유 v${config.publishedRevision} · 게시 ${timestamp}`;
        set(publication, {position:'static', 'max-width':'40vw', 'font-size':'12px', 'line-height':'1.4', margin:'0', color:'#cfdae4'});
        controls.append(publication);
      }
      document.body.append(controls);
      if (audience) controls.style.setProperty('display', 'none', 'important');
      let notesPanel, notesText, notesButton;
      if (!audience && !config.audience && config.sharedNotes === true) {
        notesPanel = document.createElement('aside'); notesPanel.id = 'sd-shared-notes'; notesPanel.hidden = true;
        notesPanel.setAttribute('aria-label', '공유된 발표자 노트'); notesPanel.tabIndex = 0;
        notesPanel.style.cssText = 'position:fixed;left:0;right:0;bottom:56px;height:min(30vh,220px);box-sizing:border-box;overflow:auto;background:#fff;color:#172033;padding:16px 24px;z-index:2147483645;font:16px/1.6 system-ui;text-align:left;transform:none';
        notesText = document.createElement('div'); notesText.style.whiteSpace = 'pre-wrap'; notesPanel.append(notesText);
        document.body.append(notesPanel);
        notesButton = document.createElement('button'); notesButton.type = 'button'; notesButton.textContent = '발표자 노트 보기';
        notesButton.setAttribute('aria-controls', notesPanel.id); notesButton.setAttribute('aria-expanded', 'false'); controls.append(notesButton);
        notesButton.addEventListener('click', () => {
          notesPanel.hidden = !notesPanel.hidden;
          notesButton.setAttribute('aria-expanded', String(!notesPanel.hidden));
          notesButton.textContent = notesPanel.hidden ? '발표자 노트 보기' : '발표자 노트 닫기'; fit();
        });
        notesPanel.addEventListener('click', event => event.stopPropagation());
      }
      const curtain = document.createElement('div'), pointer = document.createElement('div');
      curtain.id = 'sd-black-screen'; pointer.id = 'sd-laser-pointer';
      curtain.style.cssText = 'position:fixed;inset:0;background:#000;z-index:2147483646;pointer-events:none;display:none';
      pointer.style.cssText = 'position:fixed;width:18px;height:18px;border-radius:50%;background:#f33;border:2px solid white;box-shadow:0 0 16px #f33;transform:translate(-50%,-50%);z-index:2147483647;pointer-events:none;display:none';
      document.body.append(curtain, pointer);
      const state = (data, broadcast = true) => {
        if (typeof data.black === 'boolean') black = data.black;
        if (typeof data.laser === 'boolean') laser = data.laser;
        curtain.style.display = black ? 'block' : 'none';
        pointer.style.display = laser && !black ? 'block' : 'none';
        if (Number.isFinite(data.x) && Number.isFinite(data.y)) {
          const rect = stage.getBoundingClientRect();
          pointer.style.left = `${rect.left + Math.max(0,Math.min(1,data.x)) * rect.width}px`;
          pointer.style.top = `${rect.top + Math.max(0,Math.min(1,data.y)) * rect.height}px`;
        }
        if (broadcast) notify({black, laser, ...(Number.isFinite(data.x) ? {x:data.x,y:data.y} : {})});
      };
      addEventListener('pointermove', event => { if (laser && !clean) { const rect=stage.getBoundingClientRect(); state({x:(event.clientX-rect.left)/rect.width,y:(event.clientY-rect.top)/rect.height}); } });
      const [previous, next, fullscreen] = controls.querySelectorAll('button');
      const count = controls.querySelector('output');
      previous.addEventListener('click', () => go(getCurrent() - 1));
      next.addEventListener('click', () => go(getCurrent() + 1));
      fullscreen.disabled = !document.fullscreenEnabled;
      fullscreen.addEventListener('click', async () => {
        try {
          if (document.fullscreenElement) await document.exitFullscreen();
          else await document.documentElement.requestFullscreen();
        } catch { count.textContent = '전체 화면을 사용할 수 없습니다'; }
      });
      document.addEventListener('fullscreenchange', () => {
        const label = document.fullscreenElement ? '전체 화면 종료' : '전체 화면';
        fullscreen.textContent = label; fullscreen.setAttribute('aria-label', label);
      });
      // Prevent legacy click-to-advance handlers from also handling our buttons.
      controls.addEventListener('click', event => event.stopPropagation());
      const fit = () => {
        const available = Math.max(1, innerHeight - (clean || audience ? 0 : 56) - (notesPanel && !notesPanel.hidden ? notesPanel.offsetHeight : 0));
        const scale = Math.min(innerWidth / 1920, available / 1080);
        set(stage, {left:`${(innerWidth - 1920 * scale) / 2}px`, top:`${(available - 1080 * scale) / 2}px`, transform:`scale(${scale})`});
      };
      addEventListener('resize', fit);
      navigate = event => {
        if (clean || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        const key = event.key;
        if (notesPanel?.contains(event.target)) {
          if (key === 'Escape') { notesPanel.hidden = true; notesButton.setAttribute('aria-expanded','false'); notesButton.textContent='발표자 노트 보기'; notesButton.focus(); fit(); }
          event.stopImmediatePropagation(); return;
        }
        if (key === 'Escape') { notify({type:'present-escape'}); return; }
        if (['b','B','l','L'].includes(key) && !(event.target instanceof Element && (event.target.isContentEditable || event.target.closest('input,textarea,select,button,a,[role="link"]')))) {
          event.preventDefault(); event.stopImmediatePropagation();
          state(key.toLowerCase() === 'b' ? {black:!black} : {laser:!laser}); return;
        }
        if (!['ArrowRight','ArrowDown','PageDown','ArrowLeft','ArrowUp','PageUp',' ','Home','End'].includes(key)) return;
        const target = event.target;
        const controlShortcut = controls.contains(target) && key !== ' ';
        if (!controlShortcut && target instanceof Element && (target.isContentEditable || target.closest('input,textarea,select,button,a,[role="link"]'))) {
          // Keep native caret/activation behavior without feeding imported slide shortcuts.
          event.stopImmediatePropagation(); return;
        }
        event.preventDefault(); event.stopImmediatePropagation();
        if (key === 'Home') go(0);
        else if (key === 'End') go(slides.length - 1);
        else go(getCurrent() + (['ArrowLeft','ArrowUp','PageUp'].includes(key) || key === ' ' && event.shiftKey ? -1 : 1));
      };
      return {
        show(index) {
          slides.forEach((slide, i) => {
            const active = i === index;
            slide.classList.toggle('active', active);
            slide.inert = !active;
            slide.setAttribute('aria-hidden', String(!active));
            if (!active) set(slide, {display:'none'});
            else {
              const [value, priority] = originalDisplay.get(slide);
              slide.style.setProperty('display', value, priority);
              const display = getComputedStyle(slide).display;
              set(slide, {display:display === 'none' ? 'block' : display});
            }
          });
          previous.disabled = index === 0; next.disabled = index === slides.length - 1;
          count.textContent = `${index + 1} / ${slides.length}`;
          if (notesText) notesText.textContent = slides[index]?.querySelector('.notes')?.textContent || '이 슬라이드에는 노트가 없습니다.';
          fit();
        },
        command(data) {
          if (data.type === 'present-go' && Number.isInteger(data.index)) go(data.index);
          if (data.type === 'present-state') state(data, false);
        },
        clean() { clean = true; controls.remove(); notesPanel?.remove(); notesPanel = null; curtain.remove(); pointer.remove(); fit(); },
      };
    },
  };
})();
