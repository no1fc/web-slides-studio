(function (global) {
  'use strict';
  // name: [label, keyframes by property, default duration(ms), loops by default]
  // Objects are positioned with the individual translate/rotate properties, so presets
  // animate transform (composited additively) and never overwrite placement.
  const move = (from) => ({ opacity: [0, 1], transform: [from, 'translate(0,0)'] });
  const presets = {
    appear: ['나타내기', { opacity: [0, 1] }, 1, false],
    fade: ['페이드', { opacity: [0, 1] }, 500, false],
    'slide-up': ['아래에서 올라오기', move('translateY(80px)'), 500, false],
    'slide-down': ['위에서 내려오기', move('translateY(-80px)'), 500, false],
    'slide-left': ['오른쪽에서 들어오기', move('translateX(80px)'), 500, false],
    'slide-right': ['왼쪽에서 들어오기', move('translateX(-80px)'), 500, false],
    zoom: ['확대되며 나타나기', { opacity: [0, 1], transform: ['scale(.6)', 'scale(1)'] }, 500, false],
    float: ['둥실 떠 있기', { transform: ['translateY(0)', 'translateY(-24px)', 'translateY(0)'] }, 2400, true],
    pulse: ['맥박처럼 커졌다 작아지기', { transform: ['scale(1)', 'scale(1.08)', 'scale(1)'] }, 1600, true],
    spin: ['회전', { transform: ['rotate(0deg)', 'rotate(360deg)'] }, 4000, true],
    shake: ['흔들기', { transform: [0, -12, 12, -8, 8, 0].map(x => `translateX(${x}px)`) }, 800, true],
  };
  const whole = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
  // Accepts the legacy string form or {effect,duration,delay,loop}; returns the full form.
  function normalize(value) {
    const raw = typeof value === 'string' ? { effect: value } : value;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['effect', 'duration', 'delay', 'loop'].includes(key)))
      throw new Error('개체 효과 값 오류');
    if (raw.effect === 'none') return { effect: 'none', duration: 0, delay: 0, loop: false };
    const preset = Object.hasOwn(presets, raw.effect) && presets[raw.effect];
    const result = { effect: raw.effect, duration: raw.duration ?? preset[2], delay: raw.delay ?? 0, loop: raw.loop ?? preset[3] };
    if (!preset || !whole(result.duration, 1, 20000) || !whole(result.delay, 0, 20000) || typeof result.loop !== 'boolean')
      throw new Error('개체 효과 값 오류: 시간은 20,000ms 이하의 정수로 입력해 주세요.');
    return result;
  }
  // Stored form: the bare name when every option is the preset default.
  function compact(value) {
    const full = normalize(value), preset = presets[full.effect];
    return !preset || full.duration === preset[2] && !full.delay && full.loop === preset[3] ? full.effect : full;
  }
  function run(element, value) {
    const full = normalize(value);
    if (full.effect === 'none') return [];
    return Object.entries(presets[full.effect][1]).map(([property, frames]) => element.animate({ [property]: frames }, {
      duration: full.duration, delay: full.delay, fill: 'backwards', easing: full.effect === 'spin' ? 'linear' : 'ease-out',
      iterations: full.loop ? Infinity : 1, composite: property === 'transform' ? 'add' : 'replace',
    }));
  }
  function attach(config, slides, edit) {
    let stopped = edit, running = [], previous = -1, cleanup = null;
    const cancel = () => {
      for (const animation of running) animation.cancel(); running = [];
      try { cleanup?.(); } catch (error) { console.error(error); }
      cleanup = null;
    };
    function play(index) {
      if (stopped || index === previous) return;
      previous = index; cancel();
      const slide = slides[index]; if (!slide) return;
      if (!global.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
        const type = config.state?.transitions?.[slide.dataset.sdSlide];
        if (type === 'fade') running.push(slide.animate([{opacity:0},{opacity:1}], {duration:500}));
        if (type === 'push') running.push(slide.animate([{translate:'1920px 0'},{translate:'0px 0'}], {duration:500,easing:'ease-out'}));
        for (const object of slide.querySelectorAll('[data-sd-id]')) {
          const effect = config.state?.animations?.[object.dataset.sdId];
          if (effect) try { running.push(...run(object, effect)); } catch { /* A newer state can name effects this viewer lacks. */ }
        }
      }
      // Per-slide JavaScript: runs on entry, may return a cleanup function for exit.
      try {
        const result = global.SDSlideScripts?.[slide.dataset.sdSlide]?.(slide);
        if (typeof result === 'function') cleanup = result;
      } catch (error) { console.error('슬라이드 JavaScript 오류', error); }
    }
    // Imported decks can navigate using their own goSlide/keyboard handlers.
    const observer = new MutationObserver(() => {
      const active = slides.findIndex(slide => slide.classList.contains('active'));
      if (active >= 0) play(active);
    });
    if (!edit) slides.forEach(slide => observer.observe(slide, {attributes:true,attributeFilter:['class']}));
    let previewing = [];
    return {
      play,
      // Editor-only: show an effect once without touching saved state.
      preview(element, value) {
        for (const animation of previewing) animation.cancel();
        previewing = run(element, value);
        const full = normalize(value);
        if (full.loop) setTimeout(() => previewing.forEach(animation => animation.cancel()), full.delay + full.duration * 2);
      },
      stop() { stopped = true; observer.disconnect(); cancel(); },
    };
  }
  global.SDEffects = { attach, presets, normalize, compact };
})(globalThis);
