(function (global) {
  'use strict';
  function attach(config, slides, edit) {
    let stopped = edit, running = [], previous = -1;
    const cancel = () => { for (const animation of running) animation.cancel(); running = []; };
    function play(index) {
      if (stopped || index === previous || global.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
      previous = index; cancel();
      const slide = slides[index]; if (!slide) return;
      const type = config.state?.transitions?.[slide.dataset.sdSlide];
      if (type === 'fade') running.push(slide.animate([{opacity:0},{opacity:1}], {duration:500}));
      if (type === 'push') running.push(slide.animate([{translate:'1920px 0'},{translate:'0px 0'}], {duration:500,easing:'ease-out'}));
      for (const object of slide.querySelectorAll('[data-sd-added]')) {
        const effect = config.state?.animations?.[object.dataset.sdId];
        if (effect === 'fade' || effect === 'appear') running.push(object.animate([{opacity:0},{opacity:1}], {duration:effect === 'fade' ? 500 : 1}));
      }
    }
    // Imported decks can navigate using their own goSlide/keyboard handlers.
    const observer = new MutationObserver(() => {
      const active = slides.findIndex(slide => slide.classList.contains('active'));
      if (active >= 0) play(active);
    });
    if (!edit) slides.forEach(slide => observer.observe(slide, {attributes:true,attributeFilter:['class']}));
    return { play, stop() { stopped = true; observer.disconnect(); cancel(); } };
  }
  global.SDEffects = { attach };
})(globalThis);
