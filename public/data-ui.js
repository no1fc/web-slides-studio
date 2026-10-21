/* Structured data and effects use the same validated revision/history path. */
(() => {
  'use strict';
  const label = (name, input) => { const row=el('label',name); row.append(input); return row; };
  const input = (id, value, type='text') => { const e=el('input');e.id=id;e.type=type;e.value=value;return e; };
  let modalBusy=false;
  $('dialog').addEventListener('cancel',event=>{if(modalBusy)event.preventDefault();});
  function modalAction(fn, status) {
    const run=status?transitionAction(fn,status):action(fn);let working=false;
    return async()=>{
      if(working||transitionBusy)return;working=true;modalBusy=true;
      const controls=[$('closeDialog'),...$('dialogBody').querySelectorAll('input,textarea,button,select')],disabled=controls.map(c=>c.disabled);
      controls.forEach(c=>c.disabled=true);
      try{await run();}finally{controls.forEach((c,i)=>c.disabled=disabled[i]);working=false;modalBusy=false;}
    };
  }
  async function commit(candidate, selection=[]) {
    const context=objectContext(), epoch=editEpoch;
    const result=await api(`/decks/${deck.id}/validate`,'POST',{state:candidate});
    if (!currentObjectContext(context) || editEpoch!==epoch) throw new Error('편집 내용이 바뀌었습니다. 다시 적용해 주세요.');
    checkpoint();state=clone(result.state);mark();await flush();renderSlides();refreshFrame(selection);
  }
  function dataDialog(kind, id) {
    const old=id ? {...nativeAdded(id),...state.patches[id]} : null;
    if (id && (!old || old.kind!==kind || objectLocked(id))) return;
    const value=kind==='table' ? SDData.normalizeTable(old?.table) : SDData.normalizeChart(old?.chart);
    const body=dialog(kind==='table'?'표 데이터 편집':'차트 데이터 편집');
    body.append(el('p',kind==='table'?'행은 줄바꿈, 열은 탭으로 구분합니다. 스프레드시트의 셀을 복사해 붙여넣을 수 있습니다. 최대 20행·10열입니다.':'첫 행은 항목·계열 이름, 다음 행은 범주·숫자입니다. 열은 탭, 행은 줄바꿈으로 구분합니다. 최대 20범주·5계열입니다.','tool-help'));
    const area=el('textarea');area.id='dataGridValue';area.rows=10;area.spellcheck=false;
    area.value=SDData.serializeGrid(kind==='table'?value.rows:[['항목',...value.series.map(s=>s.name)],...value.categories.map((c,i)=>[c,...value.series.map(s=>String(s.values[i]))])]);
    body.append(label('데이터',area));
    const font=input('dataFontSize',value.fontSize,'number');font.min=6;font.max=400;body.append(label('글자 크기 px',font));
    let type,header;
    if (kind==='table') {
      header=input('tableHeaderValue','', 'checkbox');header.checked=value.header;body.append(label('첫 행을 제목 행으로 표시',header));
      for (const [key,name] of [['color','글자 색'],['fill','셀 배경'],['headerFill','제목 행 배경'],['border','테두리 색']]) body.append(label(name,input('data-'+key,value[key],'color')));
    } else {
      type=el('select');type.id='chartTypeValue';for(const [v,n] of [['bar','막대'],['line','꺾은선'],['pie','원형']]){const o=el('option',n);o.value=v;type.append(o);}type.value=value.type;body.append(label('차트 종류',type));
      body.append(label('계열 색 (쉼표로 구분한 #RRGGBB)',input('chartColorsValue',value.colors.join(','))));
    }
    const error=el('p');error.id='dataEditError';error.setAttribute('role','alert');body.append(error);
    const apply=el('button','적용','primary');apply.id='applyDataBtn';
    apply.onclick=modalAction(async()=>{
      try {
        const rows=SDData.parseGrid(area.value);
        let data;
        if(kind==='table') data=SDData.normalizeTable({...value,rows,header:header.checked,fontSize:Number(font.value),...Object.fromEntries(['color','fill','headerFill','border'].map(k=>[k,$('data-'+k).value]))});
        else {
          const names=rows.shift();
          if(names.length<2 || rows.some(row=>row.length!==names.length || row.slice(1).some(v=>!v.trim() || !Number.isFinite(Number(v))))) throw new Error('각 행의 열 개수와 숫자를 확인해 주세요.');
          data=SDData.normalizeChart({type:type.value,categories:rows.map(r=>r[0]),series:names.slice(1).map((name,i)=>({name,values:rows.map(r=>Number(r[i+1]))})),colors:$('chartColorsValue').value.split(',').map(c=>c.trim()),fontSize:Number(font.value)});
        }
        const candidate=clone(state), objectId=id||uid('a');
        if(id) candidate.patches[id]={...candidate.patches[id],[kind]:data};
        else candidate.added.push({id:objectId,slide:state.order[index],kind,x:180,y:200,w:1200,h:600,[kind]:data});
        await commit(candidate,[objectId]);$('dialog').close();
      }catch(e){error.textContent=e.message;}
    },'데이터 저장 중…');body.append(apply);
  }
  $('addTableBtn').onclick=action(()=>dataDialog('table'));
  $('addChartBtn').onclick=action(()=>dataDialog('chart'));
  $('editDataBtn').onclick=action(()=>dataDialog(nativeAdded(selected?.id)?.kind,selected?.id));
  $('effectsBtn').onclick=action(()=>{
    const slide=state.order[index], object=selected && nativeAdded(selected.id), body=dialog('전환·개체 효과');
    const choice=(id,choices,value)=>{const select=el('select');select.id=id;for(const [v,n] of choices){const o=el('option',n);o.value=v;select.append(o);}select.value=value||'none';return select;};
    const transition=choice('transitionValue',[['none','없음'],['fade','페이드'],['push','왼쪽으로 밀기']],state.transitions[slide]);body.append(label('현재 슬라이드 전환',transition));
    const animation=choice('animationValue',[['none','없음'],['appear','나타내기'],['fade','페이드']],object&&state.animations[object.id]);animation.disabled=!object||objectLocked(object.id);body.append(label('선택한 추가 개체의 진입 효과',animation));
    body.append(el('p','발표에서 슬라이드 진입 시 함께 재생합니다. 편집·썸네일·PDF는 최종 모습을 표시합니다. PPTX에서 이미지 배경으로 보존된 개체의 효과는 적용하지 않습니다.','tool-help'));
    const apply=el('button','적용','primary');apply.id='applyEffectsBtn';apply.onclick=modalAction(async()=>{const candidate=clone(state);candidate.transitions[slide]=transition.value;if(object&&!objectLocked(object.id))candidate.animations[object.id]=animation.value;await commit(candidate,object?[object.id]:[]);$('dialog').close();},'효과 저장 중…');body.append(apply);
  });
  $('pptxImportBtn').onclick=()=> $('pptxInput').click();
  $('pptxInput').onchange=action(async event=>{
    const file=event.target.files[0];event.target.value='';if(!file)return;
    if(file.size>40*1024*1024)throw new Error('PPTX는 40MB까지 가져올 수 있습니다.');
    $('busyOverlay').hidden=false;
    try {
      const report=await api('/import-pptx','POST',file),body=dialog('PPTX 가져오기 검토');
      body.append(el('p',`${report.counts.slides}장 · 편집 개체 ${report.counts.objects}개`));
      body.append(el('p','지원 범위의 내용만 변환합니다. 원본 PPTX는 보관해 주세요. 복잡한 배치·마스터·효과는 그대로 재현되지 않을 수 있습니다.','tool-help'));
      const warnings=el('ul');warnings.id='pptxImportWarnings';for(const warning of report.warnings){warnings.append(el('li',`${warning.slide ? `슬라이드 ${warning.slide}: ` : ''}${warning.message}`));}body.append(warnings);
      if(!report.warnings.length)body.append(el('p','감지된 변환 경고가 없습니다. 가져온 후 외형을 확인해 주세요.'));
      const accept=el('button','변환 결과 가져오기','primary');accept.id='confirmPptxImportBtn';accept.onclick=modalAction(async()=>{const created=await api('/import-pptx?confirm=1','POST',file);$('dialog').close();await openDeck(created.id);});body.append(accept);
    } finally {$('busyOverlay').hidden=true;}
  });
})();
