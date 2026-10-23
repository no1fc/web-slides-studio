(() => {
  const clock = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' });
  globalThis.SDTime = { format(value, seconds = false) {
    if (!value || !Number.isFinite(new Date(value).getTime())) return '기록 없음';
    const p = Object.fromEntries(clock.formatToParts(new Date(value)).map(p => [p.type,p.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}${seconds ? `:${p.second} (KST)` : ''}`;
  } };
})();
