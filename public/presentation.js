(() => {
  'use strict';
  let navigate;
  // Register before imported scripts so their keyboard handlers cannot advance a second time.
  addEventListener('keydown', event => navigate?.(event), true);
  window.SDPresentation = {
    attach(slides, go, getCurrent) {
      if (!slides.length) return;
      let clean = false;
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
      document.body.append(controls);
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
        const available = Math.max(1, innerHeight - (clean ? 0 : 56));
        const scale = Math.min(innerWidth / 1920, available / 1080);
        set(stage, {left:`${(innerWidth - 1920 * scale) / 2}px`, top:`${(available - 1080 * scale) / 2}px`, transform:`scale(${scale})`});
      };
      addEventListener('resize', fit);
      navigate = event => {
        if (clean || event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
        const key = event.key;
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
          fit();
        },
        clean() { clean = true; controls.remove(); fit(); },
      };
    },
  };
})();
