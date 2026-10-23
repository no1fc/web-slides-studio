(() => {
  'use strict';
  window.SDPreflight = {
    open({frame, origin, onSelect}) {
      const dialog = document.createElement('dialog');
      dialog.style.cssText = 'width:min(760px,92vw);max-height:85vh;overflow:auto;border:1px solid #c7d4df;border-radius:14px;padding:24px';
      const title = document.createElement('h2'); title.textContent = '발표 전 점검';
      const status = document.createElement('p'); status.textContent = '슬라이드의 글·이미지·링크·위치를 확인하고 있습니다…'; status.setAttribute('role','status');
      const list = document.createElement('div');
      const close = document.createElement('button'); close.textContent = '닫기'; close.onclick = () => dialog.close();
      dialog.append(title,status,list,close); document.body.append(dialog); dialog.showModal();
      const requestId = crypto.randomUUID();
      const labels = {error:'오류',warning:'주의',manual:'확인 필요'};
      const receive = event => {
        if (event.source !== frame.contentWindow || event.origin !== origin || !event.data?.studio || event.data.type !== 'preflight-result' || event.data.requestId !== requestId) return;
        clearTimeout(timeout);
        const issues = event.data.issues || [];
        status.textContent = `오류 ${issues.filter(i=>i.severity==='error').length} · 주의 ${issues.filter(i=>i.severity==='warning').length} · 확인 필요 ${issues.filter(i=>i.severity==='manual').length}. 자동으로 내용을 변경하지 않습니다.`;
        for (const issue of issues) {
          const item = document.createElement('section'); item.style.cssText='border-top:1px solid #d6dee5;padding:12px 0';
          const button = document.createElement('button'); button.textContent = `${labels[issue.severity] || '확인 필요'} · ${issue.index+1}장 · ${issue.message}`;
          button.style.cssText = 'text-align:left;white-space:normal;width:100%';
          button.onclick = () => { dialog.close(); onSelect?.(issue); };
          const hint = document.createElement('p'); hint.textContent = issue.hint;
          item.append(button,hint); list.append(item);
        }
      };
      const timeout = setTimeout(()=>{status.textContent='점검 응답을 받지 못했습니다. 편집 화면이 로드된 뒤 다시 시도하세요.';},15000);
      addEventListener('message',receive);
      dialog.addEventListener('close',()=>{clearTimeout(timeout);removeEventListener('message',receive);dialog.remove();},{once:true});
      frame.contentWindow.postMessage({studio:true,type:'preflight',requestId},origin);
    },
  };
})();
