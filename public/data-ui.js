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
    body.append(el('p',kind==='table'?'셀을 눌러 입력하세요. 셀을 선택하고 스프레드시트의 여러 셀을 붙여넣을 수 있습니다. 최대 20행·10열입니다.':'첫 행은 계열 이름, 첫 열은 범주입니다. 나머지 셀에는 숫자를 입력하세요. 최대 20범주·5계열입니다.','tool-help'));
    let rows=kind==='table'?value.rows.map(row=>[...row]):[['항목',...value.series.map(s=>s.name)],...value.categories.map((c,i)=>[c,...value.series.map(s=>String(s.values[i]))])];
    const minRows=kind==='table'?1:2, minCols=kind==='table'?1:2, maxRows=kind==='table'?20:21, maxCols=kind==='table'?10:6;
    let activeRow=1,activeCol=1,bulkValid=true;
    const colors=kind==='chart'?[...value.colors]:[];
    const toolbar=el('div',null,'data-grid-toolbar'), count=el('span',null,'data-grid-count');count.setAttribute('aria-live','polite');
    const grid=el('div',null,'data-grid-scroll');grid.id='dataGrid';
    const bulk=el('details',null,'data-grid-bulk');bulk.id='dataBulkDetails';bulk.append(el('summary','텍스트로 한 번에 입력 (탭으로 구분)'));
    const area=el('textarea');area.id='dataGridValue';area.rows=6;area.spellcheck=false;
    area.value=SDData.serializeGrid(rows);bulk.append(label('전체 데이터',area));
    body.append(toolbar,grid,bulk);
    const colorFields=el('div',null,'data-series-colors');
    function renderColors() {
      if(kind!=='chart')return;
      const names=type.value==='pie'?rows.slice(1).map(row=>row[0]):rows[0].slice(1);
      const palette=[...colors];while(colors.length<names.length)colors.push(palette[colors.length%palette.length]);
      colorFields.replaceChildren();
      names.forEach((name,i)=>{
        const picker=input('chartColor-'+i,colors[i%colors.length],'color');
        picker.oninput=()=>{colors[i]=picker.value;};
        colorFields.append(label(`${name||`${i+1}번`} 색`,picker));
      });
    }
    function checkGrid(next) {
      if(next.length<minRows||next.length>maxRows||next[0].length<minCols||next[0].length>maxCols)throw new Error(`데이터는 ${minRows}~${maxRows}행, ${minCols}~${maxCols}열이어야 합니다.`);
      if(next.some(row=>row.length!==next[0].length))throw new Error('모든 행의 열 개수를 같게 입력해 주세요.');
    }
    const buttons={};
    function updateControls() {
      buttons.addRow.disabled=!bulkValid||rows.length===maxRows;
      buttons.addCol.disabled=!bulkValid||rows[0].length===maxCols;
      buttons.removeRow.disabled=!bulkValid||rows.length===minRows||(kind==='chart'&&activeRow===0);
      buttons.removeCol.disabled=!bulkValid||rows[0].length===minCols||(kind==='chart'&&activeCol===0);
      count.textContent=`${rows.length}행 × ${rows[0].length}열 · 선택 ${activeRow+1}행 ${activeCol+1}열`;
      grid.querySelectorAll('textarea').forEach(cell=>{cell.disabled=!bulkValid;});
    }
    function sync() {area.value=SDData.serializeGrid(rows);error.textContent='';bulkValid=true;}
    function renderGrid(focus=false) {
      const table=el('table');table.style.minWidth=`${38+rows[0].length*140}px`;table.setAttribute('aria-label',kind==='table'?'표 데이터 셀':'차트 데이터 셀');
      const head=el('thead'), headings=el('tr');headings.append(el('th',''));
      rows[0].forEach((_,c)=>{const th=el('th',String.fromCharCode(65+c));th.scope='col';headings.append(th);});head.append(headings);table.append(head);
      const tbody=el('tbody');
      rows.forEach((row,r)=>{
        const tr=el('tr'), heading=el('th',String(r+1));heading.scope='row';tr.append(heading);
        row.forEach((value,c)=>{
          const td=el('td'),cell=el('textarea');cell.rows=1;cell.value=value;cell.spellcheck=false;
          cell.dataset.row=r;cell.dataset.col=c;cell.setAttribute('aria-label',`${r+1}행 ${c+1}열`);
          if(kind==='chart'&&r>0&&c>0)cell.inputMode='decimal';
          cell.onfocus=()=>{activeRow=r;activeCol=c;updateControls();};
          cell.oninput=()=>{rows[r][c]=cell.value;sync();if(kind==='chart'&&(r===0||c===0))renderColors();};
          cell.onpaste=event=>{
            const text=event.clipboardData?.getData('text/plain');if(!text||!/[\t\r\n]/.test(text))return;
            event.preventDefault();
            try {
              const pasted=SDData.parseGrid(text), width=pasted[0].length;
              if(pasted.some(row=>row.length!==width)||r+pasted.length>maxRows||c+width>maxCols)throw new Error('붙여넣을 셀의 열 개수와 최대 행·열 수를 확인해 주세요.');
              const height=Math.max(rows.length,r+pasted.length),cols=Math.max(rows[0].length,c+width);
              const next=Array.from({length:height},(_,i)=>Array.from({length:cols},(_,j)=>rows[i]?.[j]??''));
              pasted.forEach((row,i)=>row.forEach((value,j)=>{next[r+i][c+j]=value;}));rows=next;
              sync();renderGrid(true);renderColors();
            }catch(e){error.textContent=e.message;}
          };
          td.append(cell);tr.append(td);
        });tbody.append(tr);
      });table.append(tbody);grid.replaceChildren(table);updateControls();
      if(focus)grid.querySelector(`[data-row="${activeRow}"][data-col="${activeCol}"]`)?.focus();
    }
    for(const [key,id,name] of [['addRow','dataAddRowBtn','행 추가'],['removeRow','dataRemoveRowBtn','선택 행 삭제'],['addCol','dataAddColumnBtn','열 추가'],['removeCol','dataRemoveColumnBtn','선택 열 삭제']]) {
      const button=el('button',name);button.id=id;button.type='button';buttons[key]=button;toolbar.append(button);
      button.onclick=()=>{
        if(key==='addRow'){rows.push(rows[0].map((_,c)=>kind==='chart'&&c>0?'0':''));activeRow=rows.length-1;}
        if(key==='addCol'){rows.forEach((row,r)=>row.push(kind==='chart'?(r===0?`계열 ${rows[0].length}`:'0'):''));activeCol=rows[0].length-1;}
        if(key==='removeRow'){rows.splice(activeRow,1);if(kind==='chart'&&type.value==='pie')colors.splice(activeRow-1,1);activeRow=Math.min(activeRow,rows.length-1);}
        if(key==='removeCol'){rows.forEach(row=>row.splice(activeCol,1));if(kind==='chart'&&type.value!=='pie')colors.splice(activeCol-1,1);activeCol=Math.min(activeCol,rows[0].length-1);}
        sync();renderGrid(true);renderColors();
      };
    }
    toolbar.append(count);
    area.oninput=()=>{
      try {const next=SDData.parseGrid(area.value);checkGrid(next);rows=next;bulkValid=true;activeRow=Math.min(activeRow,rows.length-1);activeCol=Math.min(activeCol,rows[0].length-1);error.textContent='';renderGrid();renderColors();}
      catch(e){bulkValid=false;error.textContent=e.message;updateControls();}
    };
    const formatting=el('div',null,'data-format-fields');body.append(formatting);
    const font=input('dataFontSize',value.fontSize,'number');font.min=6;font.max=400;formatting.append(label('글자 크기 px',font));
    let type,header;
    if (kind==='table') {
      header=input('tableHeaderValue','', 'checkbox');header.checked=value.header;formatting.append(label('첫 행을 제목 행으로 표시',header));
      for (const [key,name] of [['color','글자 색'],['fill','셀 배경'],['headerFill','제목 행 배경'],['border','테두리 색']]) formatting.append(label(name,input('data-'+key,value[key],'color')));
    } else {
      type=el('select');type.id='chartTypeValue';for(const [v,n] of [['bar','막대'],['line','꺾은선'],['pie','원형']]){const o=el('option',n);o.value=v;type.append(o);}type.value=value.type;formatting.append(label('차트 종류',type));
      type.onchange=renderColors;body.append(colorFields);
      body.append(el('p','원형 차트는 계열 하나와 0 이상의 값이 필요합니다. 원형에서는 범주별 색을 설정합니다.','tool-help'));
    }
    const error=el('p');error.id='dataEditError';error.setAttribute('role','alert');body.append(error);
    activeRow=Math.min(activeRow,rows.length-1);activeCol=Math.min(activeCol,rows[0].length-1);renderGrid();renderColors();
    const apply=el('button','적용','primary');apply.id='applyDataBtn';
    apply.onclick=modalAction(async()=>{
      try {
        const rows=SDData.parseGrid(area.value);checkGrid(rows);
        let data;
        if(kind==='table') data=SDData.normalizeTable({...value,rows,header:header.checked,fontSize:Number(font.value),...Object.fromEntries(['color','fill','headerFill','border'].map(k=>[k,$('data-'+k).value]))});
        else {
          const names=rows.shift();
          if(names.length<2 || rows.some(row=>row.length!==names.length || row.slice(1).some(v=>!v.trim() || !Number.isFinite(Number(v))))) throw new Error('각 행의 열 개수와 숫자를 확인해 주세요.');
          data=SDData.normalizeChart({type:type.value,categories:rows.map(r=>r[0]),series:names.slice(1).map((name,i)=>({name,values:rows.map(r=>Number(r[i+1]))})),colors,fontSize:Number(font.value)});
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
})();
