import { readFile, readdir, mkdir, cp, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { prepareDeck, renderDeck, validateState, initialState } from './deck.js';
import { safePath } from './archive.js';
import { collectFiles } from './files.js';
import { codeIds } from './authoring.js';

const conflict = () => Object.assign(new Error('다른 창에서 자료가 변경되었습니다. 최신 자료를 다시 열고 AI 변경을 확인해 주세요.'), {status:409});
const uuid = value => { if (!/^[a-f0-9-]{36}$/.test(value)) throw new Error('항목 ID 오류'); return value; };
const slideFields=['clones','scenes','slideCode','slideMasters','notes','slideLayouts','transitions'];
function objectOwners(deck,...states) {
  const owners=new Map(deck.elements.map(e=>[e.id,e.slide]));
  for(const state of states) {
    for(const [slide,source] of Object.entries(state.clones)) for(const e of deck.elements.filter(e=>e.slide===source)) owners.set(slide+'--'+e.id,slide);
    for(const [slide,code] of Object.entries(state.slideCode)) for(const id of codeIds(code.html)) owners.set(id,slide);
    const visit=(object,slide)=>{owners.set(object.id,slide);for(const child of object.group?.children||[])visit(child,slide);};
    for(const object of state.added)visit(object,object.slide);
  }
  return owners;
}
function slideSnapshot(state,slide,owners) {
  return JSON.stringify({
    ...Object.fromEntries(slideFields.map(key=>[key,state[key][slide]])),
    added:state.added.filter(object=>object.slide===slide),
    patches:Object.fromEntries(Object.entries(state.patches).filter(([id])=>owners.get(id)===slide)),
    animations:Object.fromEntries(Object.entries(state.animations).filter(([id])=>owners.get(id)===slide)),
  });
}
export class Workflows {
  constructor(store) { this.store = store; }
  proposalPath(id,pid) { return this.store.path(id, 'proposals', uuid(pid)+'.json'); }
  async proposal(id,pid) { return JSON.parse(await readFile(this.proposalPath(id,pid),'utf8')); }
  async proposals(id) {
    await this.store.meta(id);
    const dir=this.store.path(id,'proposals');
    let files; try { files=await readdir(dir); } catch(e) { if(e.code==='ENOENT') return []; throw e; }
    return (await Promise.all(files.filter(f=>f.endsWith('.json')).map(f=>this.proposal(id,f.slice(0,-5))))).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(({state,...p})=>p);
  }
  async propose(id,input) {
    return this.store.locked(id,async()=>{
      const deck=await this.store.get(id);
      if(input.revision!==deck.revision) throw conflict();
      const state=validateState(input.state,deck);
      const source=await readFile(this.store.path(id,'assets/index.html'),'utf8');
      const before=parseHTML(renderDeck(source,deck.state)).document, after=parseHTML(renderDeck(source,state)).document;
      const changes=[],owners=objectOwners(deck,deck.state,state);
      const allSlides=new Set([...deck.slides.map(s=>s.id),...Object.keys(deck.state.clones),...Object.keys(state.clones)]);
      for(const slide of allSlides) {
        const a=before.querySelector(`[data-sd-slide="${slide}"]`),b=after.querySelector(`[data-sd-slide="${slide}"]`);
        if(a?.outerHTML!==b?.outerHTML || slideSnapshot(deck.state,slide,owners)!==slideSnapshot(state,slide,owners)) changes.push({slide,beforeText:a?.textContent.slice(0,4000)||'',afterText:b?.textContent.slice(0,4000)||'',kind:!a?'added':!b?'removed':'changed'});
      }
      if (['theme','background','masters','order'].some(key=>JSON.stringify(deck.state[key])!==JSON.stringify(state[key]))) changes.push({slide:'__global__',beforeText:'현재 순서·공통 디자인',afterText:'AI가 제안한 순서·공통 디자인',kind:'global'});
      const proposal={id:randomUUID(),baseRevision:deck.revision,beforeOrder:deck.state.order,state,summary:typeof input.summary==='string'?input.summary.slice(0,500):'AI 수정 제안',status:'pending',createdAt:new Date().toISOString(),changes};
      await mkdir(this.store.path(id,'proposals'),{recursive:true});
      await this.store.atomic(this.proposalPath(id,proposal.id),proposal);
      return proposal;
    });
  }
  async apply(id,pid,input) {
    // Proposal lock serializes acceptance; Store.save performs the final revision compare-and-swap.
    return this.store.locked('proposal:'+pid,async()=>{
      const p=await this.proposal(id,pid),d=await this.store.get(id);
      if(p.status!=='pending') throw Object.assign(new Error('이미 처리한 AI 변경입니다.'),{status:409});
      if(input.revision!==d.revision || p.baseRevision!==d.revision) throw conflict();
      const selected=input.slides;
      if(!Array.isArray(selected)||!selected.length||selected.some(s=>!p.changes.some(c=>c.slide===s))) throw new Error('적용할 변경 슬라이드를 선택해 주세요.');
      const state=structuredClone(d.state);
      {
        const slides=new Set(selected.filter(s=>s!=='__global__'));
        if(JSON.stringify(d.state.masters)!==JSON.stringify(p.state.masters)&&!selected.includes('__global__')) throw new Error('공통 마스터가 변경되었습니다. 해당 변경은 공통 디자인 항목과 함께 선택해 주세요.');
        for(const key of slideFields) for(const slide of slides) {
          delete state[key][slide]; if(Object.hasOwn(p.state[key],slide)) state[key][slide]=structuredClone(p.state[key][slide]);
        }
        const owners=objectOwners(d,d.state,p.state),owner=object=>owners.get(object);
        for(const key of ['patches','animations']) for(const object of new Set([...Object.keys(state[key]),...Object.keys(p.state[key])])) if(slides.has(owner(object))) {
          delete state[key][object]; if(Object.hasOwn(p.state[key],object)) state[key][object]=structuredClone(p.state[key][object]);
        }
        state.added=[...state.added.filter(a=>!slides.has(a.slide)),...p.state.added.filter(a=>slides.has(a.slide))];
        state.order=state.order.filter(s=>!slides.has(s)||p.state.order.includes(s));
        for(const slide of p.state.order) if(slides.has(slide)&&!state.order.includes(slide)) state.order.push(slide);
        if(selected.includes('__global__')) {
          const required=p.state.order.filter(slide=>!d.state.order.includes(slide)&&!slides.has(slide));
          if(required.length) throw new Error('슬라이드 순서를 적용하려면 새로 추가된 슬라이드도 함께 선택해 주세요.');
          for(const key of ['theme','background','masters','order']) state[key]=structuredClone(p.state[key]);
        }
      }
      const result=await this.store.save(id,input.revision,state,{source:'ai',summary:p.summary});
      await this.store.atomic(this.proposalPath(id,pid),{...p,status:'applied',appliedRevision:result.revision,resolvedAt:new Date().toISOString()});
      return result;
    });
  }
  async reject(id,pid) {
    return this.store.locked('proposal:'+pid,async()=>{
      const p=await this.proposal(id,pid);
      if(p.status!=='pending') throw Object.assign(new Error('이미 처리한 AI 변경입니다.'),{status:409});
      const result={...p,status:'rejected',resolvedAt:new Date().toISOString()};
      await this.store.atomic(this.proposalPath(id,pid),result); return result;
    });
  }
  async templates() {
    const dir=join(this.store.root,'_templates'); let files=[];
    try { files=await readdir(dir); } catch(e) {if(e.code!=='ENOENT') throw e;}
    const saved=await Promise.all(files.filter(f=>/^[a-f0-9-]{36}$/.test(f)).map(async id=>{try{return JSON.parse(await readFile(join(dir,id,'template.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}));
    return [...Object.entries(builtins).map(([id,data])=>({id,name:data.name,builtin:true,slideCount:data.slides.length,description:data.slides.map(s=>s[0]).join(' · ')})),...saved.filter(Boolean)];
  }
  async saveTemplate({deckId,name}) {
    if(typeof name!=='string'||!name.trim()||name.length>100) throw new Error('템플릿 이름을 100자 이하로 입력해 주세요.');
    return this.store.locked(deckId,async()=>{
      const deck=await this.store.get(deckId),id=randomUUID(),dir=join(this.store.root,'_templates',id);
      await mkdir(dir,{recursive:true}); await cp(this.store.path(deckId,'assets'),join(dir,'assets'),{recursive:true});
      const record={id,name:name.trim(),createdAt:new Date().toISOString(),revision:deck.revision};
      await this.store.atomic(join(dir,'deck.json'),{title:deck.title,slides:deck.slides,elements:deck.elements,state:deck.state});
      await this.store.atomic(join(dir,'template.json'),record); return record;
    });
  }
  async createTemplate(id,{title}={}) {
    let input;
    if(Object.hasOwn(builtins,id)) {
      const b=builtins[id];
      const html=`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>${b.name}</title><style>${builtinCSS}</style></head><body><main id="stage">${b.slides.map(([heading,content,layout],i)=>`<section class="slide ${layout} ${i?'':'active'}"><header class="page-header"><p>${b.name}</p><p>${b.section}</p></header><h1 class="page-heading">${heading}</h1><div class="content">${content}</div><footer class="page-footer"><p>작성자 · 날짜 입력</p><p>${String(i+1).padStart(2,'0')} / ${String(b.slides.length).padStart(2,'0')}</p></footer></section>`).join('')}</main></body></html>`;
      input=prepareDeck(html); input.files=new Map([['index.html',Buffer.from(input.html)]]);
      input.state=initialState(input);
      input.state.theme.colors={...b.colors};
      for(const [index,slide] of input.slides.entries()) input.state.slideLayouts[slide.id]={type:index===0?'title':'title-body',placeholders:{}};
    } else {
      const dir=join(this.store.root,'_templates',uuid(id)); input=JSON.parse(await readFile(join(dir,'deck.json'),'utf8')); input.files=new Map();
      for(const file of await collectFiles(join(dir,'assets'))) input.files.set(file,await readFile(join(dir,'assets',file)));
    }
    if(typeof title==='string'&&title.trim()) input.title=title.trim().slice(0,180);
    return this.store.create(input);
  }
  async brands() { try{return JSON.parse(await readFile(join(this.store.root,'_brands.json'),'utf8'));}catch(e){if(e.code==='ENOENT')return [];throw e;} }
  async saveBrand(input) {
    return this.store.locked('_brands',async()=>{
      if(typeof input.name!=='string'||!input.name.trim()||input.name.length>100) throw new Error('브랜드 이름은 100자 이하로 입력해 주세요.');
      const theme={colors:input.colors,fonts:{heading:input.font,body:input.font}};
      const sample=prepareDeck('<html><body><section class="slide">브랜드</section></body></html>');
      const {initialState}=await import('./deck.js'); const state=initialState(sample);state.theme=theme;validateState(state,sample);
      const brand={id:randomUUID(),name:input.name.trim(),...theme,createdAt:new Date().toISOString()};
      if(input.logo) {
        safePath(input.logo); if(!['.png','.jpg','.jpeg','.gif','.webp'].includes(extname(input.logo).toLowerCase())) throw new Error('브랜드 로고는 이미지 파일을 선택해 주세요.');
        const source=this.store.path(input.deckId,'assets',input.logo),info=await stat(source);if(!info.isFile()||info.size>12*1024*1024)throw new Error('로고 이미지가 없거나 너무 큽니다.');
        const dir=join(this.store.root,'_brand-assets');await mkdir(dir,{recursive:true});brand.logo=brand.id+extname(input.logo).toLowerCase();await cp(source,join(dir,brand.logo));
      }
      const brands=await this.brands();brands.push(brand);await this.store.atomic(join(this.store.root,'_brands.json'),brands);return brand;
    });
  }
  async applyBrand(id,{deckId,revision}) {
    const brand=(await this.brands()).find(b=>b.id===id);if(!brand) throw new Error('브랜드를 찾을 수 없습니다.');
    const deck=await this.store.get(deckId);if(deck.revision!==revision)throw conflict();
    deck.state.theme={colors:brand.colors,fonts:brand.fonts};
    if(brand.logo) {
      const source=join(this.store.root,'_brand-assets',brand.logo),asset='assets/brand-'+brand.logo;
      const {inventory}=await import('./files.js');const info=await inventory(this.store,deckId);
      if(info.files.length>=300||info.assetBytes+(await stat(source)).size>64*1024*1024)throw new Error('자료 자산 용량 제한을 초과합니다.');
      await mkdir(this.store.path(deckId,'assets/assets'),{recursive:true});await cp(source,this.store.path(deckId,'assets',asset));
      for(const slide of deck.state.order) deck.state.added.push({id:'a-'+randomUUID(),slide,kind:'image',src:asset,x:1660,y:50,w:160,h:90});
    }
    return this.store.save(deckId,revision,deck.state,{source:'manual',summary:'브랜드 적용: '+brand.name});
  }
}
// Original layouts: editorial hierarchy and varied composition, without external assets.
const builtinCSS=`
.metric-primary,.question-panel,.result-panel,.exercise,.assignment{border-radius:var(--sd-theme-radius,0px)}
*{box-sizing:border-box}html,body{margin:0;background:#e8ebee}#stage{position:relative;width:1920px;height:1080px;transform-origin:0 0}
.slide{position:absolute;inset:0;display:none;color:var(--sd-theme-text,#172033);font-family:var(--sd-theme-body-font,Arial),"Noto Sans CJK KR","Malgun Gothic",sans-serif;background:#fff}.slide.active{display:block}
h1,h2,h3,p{margin:0}h1,h2,h3{font-family:var(--sd-theme-heading-font,Arial),"Noto Sans CJK KR","Malgun Gothic",sans-serif;word-break:keep-all;letter-spacing:-.035em}p,td,th{word-break:keep-all;overflow-wrap:break-word}
.page-header,.page-footer{position:absolute;left:110px;right:110px;display:flex;justify-content:space-between;align-items:center;font-size:24px;line-height:1.5}.page-header{top:50px;padding-bottom:22px;border-bottom:2px solid currentColor}.page-header p:first-child{font-weight:700;color:var(--sd-theme-accent,#2563eb)}.page-header p:last-child{opacity:.7}.page-footer{bottom:42px;border-top:1px solid currentColor;padding-top:18px;opacity:.7}
.page-heading{position:absolute;top:148px;left:110px;width:1700px;font-size:var(--sd-theme-heading-size,76px);line-height:1.5;font-weight:700}.content{position:absolute;left:110px;top:300px;width:1700px;height:620px;font-size:32px;line-height:1.5}
h2{font-size:48px;line-height:1.5}h3{font-size:34px;line-height:1.5}p{font-size:var(--sd-theme-body-size,32px);line-height:1.5}.label{font-size:25px;font-weight:700;color:var(--sd-theme-accent,#2563eb)}.detail{font-size:27px;line-height:1.5;opacity:.78}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:90px}.split{display:grid;grid-template-columns:1.2fr 1fr;gap:100px}.section-title{padding-bottom:26px;border-bottom:3px solid var(--sd-theme-accent,#2563eb);margin-bottom:36px}.stack{display:grid;gap:36px}.rule-row{padding:28px 0;border-bottom:1px solid currentColor}.rule-row h3{margin-bottom:12px}.large-copy{font-size:56px;line-height:1.5}.note{position:absolute;left:0;bottom:0;max-width:1700px;font-size:25px;opacity:.8}
.cover .page-heading{top:230px;width:1120px;font-size:var(--sd-theme-heading-size,106px);line-height:1.5}.cover .content{top:415px;height:505px}.cover-subtitle{max-width:1060px;font-size:42px;line-height:1.5}.cover-meta{position:absolute;right:0;top:-180px;width:440px;padding-left:40px;border-left:5px solid var(--sd-theme-accent,#2563eb)}.cover-meta .rule-row{padding:22px 0}.cover-meta .detail{margin-top:8px}.agenda{position:absolute;bottom:12px;left:0;width:1700px;display:flex;gap:80px;padding-top:30px;border-top:2px solid currentColor}.agenda p{font-size:31px}.agenda p:first-child{color:var(--sd-theme-accent,#2563eb)}
.metrics{display:grid;grid-template-columns:1.15fr 1fr;gap:100px}.metric-primary{padding:36px 48px;border-left:6px solid var(--sd-theme-accent,#2563eb);background:color-mix(in srgb,var(--sd-theme-accent,#2563eb) 7%,transparent)}.metric-value{font-size:88px;font-weight:700;line-height:1.5;letter-spacing:-.04em;margin:34px 0 28px}.metric-secondary{display:grid;grid-template-columns:1fr 1fr;gap:30px;padding:18px 0 32px;margin-bottom:32px;border-bottom:1px solid currentColor}.metric-secondary .value{font-size:47px;font-weight:700;line-height:1.5;text-align:right}.metric-secondary .detail{grid-column:1/-1}.metric-caption{margin-top:44px;font-size:28px}
.action-table{width:100%;border-collapse:collapse;font-size:29px;text-align:left}.action-table th{font-weight:700;color:var(--sd-theme-accent,#2563eb);font-size:25px;padding:0 16px 24px 0;border-bottom:3px solid currentColor}.action-table td{padding:30px 24px 30px 0;border-bottom:1px solid currentColor}.action-table th:first-child{width:43%}.decision-line{margin-top:48px;display:grid;grid-template-columns:320px 1fr;gap:32px;padding:32px 38px;background:color-mix(in srgb,var(--sd-theme-accent,#2563eb) 9%,transparent)}.decision-line h3{font-size:32px}.decision-line p{font-size:29px}
.learning-cover .cover-meta{top:-170px;width:490px}.learning-cover .cover-subtitle{max-width:1000px}.step-number{font-size:58px;line-height:1.5;font-weight:700;color:var(--sd-theme-accent,#2563eb)}.learning-path{display:grid;grid-template-columns:68px 1fr;gap:18px;align-items:center;padding:24px 0;border-bottom:1px solid currentColor}.definition{border-left:6px solid var(--sd-theme-accent,#2563eb);padding:30px 0 30px 46px}.definition .large-copy{margin:32px 0}.example h3{margin-bottom:16px}.example{padding-bottom:34px;border-bottom:1px solid currentColor}
.exercise{padding:30px 40px;margin-bottom:55px;background:color-mix(in srgb,var(--sd-theme-accent,#2563eb) 9%,transparent)}.exercise h2{font-size:42px;margin:12px 0}.timeline{display:grid;grid-template-columns:repeat(3,1fr);gap:60px}.timeline article{border-top:4px solid var(--sd-theme-accent,#2563eb);padding-top:26px}.timeline h3{margin:20px 0 12px}.timeline .detail{margin-top:20px}.recap-list{display:grid;gap:32px}.recap-item{display:grid;grid-template-columns:62px 1fr;gap:28px;padding-bottom:26px;border-bottom:1px solid currentColor}.question-panel{padding:42px;border:3px solid var(--sd-theme-accent,#2563eb)}.question-panel h2{font-size:58px;line-height:1.5;margin:18px 0 28px}.assignment{margin-top:35px;padding-top:25px;border-top:1px solid currentColor}
.proposal-cover .page-heading{font-size:96px;width:1120px}.proposal-cover .content{top:430px}.proposal-cover .cover-meta{top:-200px}.issue{padding:30px 0;border-bottom:1px solid currentColor}.issue h3{margin-bottom:18px}.result-panel{border-left:6px solid var(--sd-theme-accent,#2563eb);padding:38px 46px;background:color-mix(in srgb,var(--sd-theme-accent,#2563eb) 8%,transparent)}.result-panel h2{margin:25px 0 40px}.solution-statement{padding:42px;background:color-mix(in srgb,var(--sd-theme-accent,#2563eb) 10%,transparent);align-self:start}.solution-statement h2{font-size:62px;line-height:1.5;margin:38px 0 45px}.solution-row{display:grid;grid-template-columns:60px 1fr;gap:28px;padding-bottom:28px;margin-bottom:28px;border-bottom:1px solid currentColor}.solution-row h3{margin-bottom:12px}.budget{display:grid;grid-template-columns:1fr 1.6fr;gap:60px;margin-top:66px;padding:32px 40px;background:color-mix(in srgb,var(--sd-theme-accent,#2563eb) 8%,transparent)}.budget h2{margin-top:12px;font-size:48px}.budget .detail{margin-top:10px}.decision-summary{display:grid;grid-template-columns:.85fr 1.4fr;gap:100px}.meeting{padding-top:25px}.meeting h2{font-size:58px;margin:34px 0}.decision-items{border-top:4px solid var(--sd-theme-accent,#2563eb)}.decision-item{display:grid;grid-template-columns:230px 1fr;gap:35px;padding:32px 0;border-bottom:1px solid currentColor}.decision-item p{font-size:29px}
`;
const builtins={
  report:{name:'업무 보고서',section:'성과 · 분석 · 실행',colors:{background:'#f7f9fa',text:'#172b36',accent:'#185f78'},slides:[
    ['주간 업무 보고','<p class="cover-subtitle">성과와 과제를 정리하고,<br>다음 실행의 우선순위를 결정합니다.</p><div class="cover-meta"><p class="label">이번 보고의 범위</p><div class="rule-row"><h3>대상 기간</h3><p class="detail">[시작일 ~ 종료일 입력]</p></div><div class="rule-row"><h3>작성 팀</h3><p class="detail">[팀 이름 · 작성자 입력]</p></div></div><div class="agenda"><p>01 핵심 성과</p><p>02 현황과 과제</p><p>03 다음 실행</p></div>','cover'],
    ['핵심 성과를 숫자로 확인합니다','<div class="metrics"><article class="metric-primary"><p class="label">핵심 지표명 입력</p><p class="metric-value">[값 입력]</p><p>[단위 · 집계 기간 입력]</p><p class="metric-caption">목표 [값 입력] · 이전 기간 [값 입력]</p></article><div><article class="metric-secondary"><h3>보조 지표명 입력</h3><p class="value">[값 입력]</p><p class="detail">[단위 · 비교 기준 · 출처 입력]</p></article><article class="metric-secondary"><h3>보조 지표명 입력</h3><p class="value">[값 입력]</p><p class="detail">[단위 · 비교 기준 · 출처 입력]</p></article></div></div><p class="note">모든 수치는 입력란입니다. 실제 집계 값과 근거 자료를 넣어 주세요.</p>','metrics-page'],
    ['현황과 해결 과제를 연결합니다','<div class="two-col"><article><h2 class="section-title">현재 확인한 사실</h2><div class="stack"><div><p class="label">관찰한 변화</p><h3>[달라진 상황을 입력하세요]</h3></div><div><p class="label">판단의 근거</p><p>[고객 의견 · 측정 결과 · 사례 입력]</p></div><p class="detail">출처 [자료명 · 확인 날짜 입력]</p></div></article><article><h2 class="section-title">해석과 대응</h2><div class="stack"><div><p class="label">해결할 과제</p><h3>[가장 중요한 문제를 입력하세요]</h3></div><div><p class="label">다음 행동</p><p>[대응 방법 · 필요한 지원 입력]</p></div><p class="detail">확인 기준 [개선 여부를 판단할 기준 입력]</p></div></article></div>','analysis-page'],
    ['다음 실행을 명확하게 합의합니다','<table class="action-table"><thead><tr><th>실행 과제</th><th>담당자</th><th>완료 기한</th><th>확인 기준</th></tr></thead><tbody><tr><td>[우선 실행할 과제 입력]</td><td>[이름 입력]</td><td>[날짜 입력]</td><td>[완료 기준 입력]</td></tr><tr><td>[이어갈 과제 입력]</td><td>[이름 입력]</td><td>[날짜 입력]</td><td>[완료 기준 입력]</td></tr></tbody></table><div class="decision-line"><h3>이번 회의의 결정</h3><p>[승인할 범위와 필요한 지원을 입력하세요]</p></div>','actions-page']
  ]},
  lecture:{name:'강의 자료',section:'이해 · 적용 · 질문',colors:{background:'#fcfbf5',text:'#292b22',accent:'#646c2d'},slides:[
    ['오늘 배울 내용','<p class="cover-subtitle">[강의 주제를 입력하세요]<br>핵심 개념을 이해하고 직접 적용합니다.</p><div class="cover-meta"><p class="label">학습의 흐름</p><div class="learning-path"><p class="step-number">1</p><h3>개념 이해하기</h3></div><div class="learning-path"><p class="step-number">2</p><h3>직접 적용하기</h3></div><div class="learning-path"><p class="step-number">3</p><h3>내 말로 설명하기</h3></div></div><div class="agenda"><p>학습 목표</p><p>[수업 후 할 수 있는 일을 입력하세요]</p></div>','cover learning-cover'],
    ['핵심 개념을 이해합니다','<div class="split"><article class="definition"><p class="label">핵심 정의</p><h2 class="large-copy">[개념을 한 문장으로<br>설명하세요]</h2><p class="detail">핵심 용어 [용어와 뜻 입력]</p></article><div class="stack"><article class="example"><h3>어떤 상황에서 쓰나요?</h3><p>[이해를 돕는 실제 사례 입력]</p></article><article class="example"><h3>헷갈리기 쉬운 점</h3><p>[비슷한 개념과의 차이 입력]</p></article></div></div>','concept-page'],
    ['함께 적용해 봅니다','<div class="exercise"><p class="label">오늘의 실습 문제</p><h2>[해결할 문제 또는 활동을 입력하세요]</h2><p class="detail">준비물 [입력] · 활동 시간 [입력]</p></div><div class="timeline"><article><p class="step-number">01</p><h3>상황 읽기</h3><p>[먼저 확인할 조건 입력]</p></article><article><p class="step-number">02</p><h3>직접 시도하기</h3><p>[수행할 과제 입력]</p></article><article><p class="step-number">03</p><h3>결과 설명하기</h3><p>[함께 확인할 기준 입력]</p></article></div>','exercise-page'],
    ['배운 내용을 내 것으로 만듭니다','<div class="two-col"><div><div class="recap-list"><article class="recap-item"><p class="step-number">1</p><h3>[핵심 내용 한 가지 입력]</h3></article><article class="recap-item"><p class="step-number">2</p><h3>[직접 적용한 방법 입력]</h3></article><article class="recap-item"><p class="step-number">3</p><h3>[기억할 주의점 입력]</h3></article></div><div class="assignment"><p class="label">다음 학습 과제</p><p>[과제 내용 · 제출 기한 입력]</p></div></div><article class="question-panel"><p class="label">질문과 대화</p><h2>어떤 질문이<br>생겼나요?</h2><p>[더 알아보고 싶은 내용을 적어 보세요]</p></article></div>','recap-page']
  ]},
  proposal:{name:'제안서',section:'문제 · 해결 · 의사결정',colors:{background:'#faf7f2',text:'#302720',accent:'#a24526'},slides:[
    ['실행으로 이어지는 제안','<p class="cover-subtitle">[제안 제목을 입력하세요]<br>[고객에게 만들 변화를 한 문장으로 입력하세요]</p><div class="cover-meta"><div class="rule-row"><p class="label">제안 대상</p><h3>[고객·기관명 입력]</h3></div><div class="rule-row"><p class="label">작성자</p><h3>[이름 · 소속 입력]</h3></div><div class="rule-row"><p class="label">제안일</p><h3>[날짜 입력]</h3></div></div><div class="agenda"><p>문제 정의</p><p>해결 방안</p><p>실행 계획</p><p>의사결정</p></div>','cover proposal-cover'],
    ['문제와 기대하는 변화를 정의합니다','<div class="two-col"><article><h2 class="section-title">지금의 상황</h2><div class="issue"><h3>[해결할 어려움 입력]</h3><p>[누가 · 언제 · 어떤 불편을 겪는지 입력]</p></div><div class="issue"><p class="label">판단의 근거</p><p>[관찰 결과 · 고객 의견 · 자료 입력]</p></div></article><article class="result-panel"><p class="label">우리가 바꿀 결과</p><h2>[고객에게 필요한<br>변화를 입력하세요]</h2><p>성공 지표 [지표명 입력]</p><p class="detail">현재 [값 입력] · 목표 [값 입력]</p></article></div><p class="note">기대 효과와 수치는 가정과 근거를 구분해 작성하세요.</p>','problem-page'],
    ['제안의 핵심과 범위를 설명합니다','<div class="split"><article class="solution-statement"><p class="label">핵심 제안</p><h2>[해결 방법을<br>한 문장으로 입력]</h2><p class="detail">[이 방법을 선택한 이유 입력]</p></article><div><article class="solution-row"><p class="step-number">1</p><div><h3>제공할 범위</h3><p>[주요 기능 · 업무 · 산출물 입력]</p></div></article><article class="solution-row"><p class="step-number">2</p><div><h3>고객이 얻는 변화</h3><p>[실무에서 달라지는 점 입력]</p></div></article><article class="solution-row"><p class="step-number">3</p><div><h3>성공을 확인하는 방법</h3><p>[검증 기준 · 제외 범위 입력]</p></div></article></div></div>','solution-page'],
    ['일정과 예산을 구체화합니다','<div class="timeline"><article><p class="step-number">01</p><h3>준비와 합의</h3><p>[기간 입력]</p><p class="detail">산출물 [요구사항 · 범위 입력]</p></article><article><p class="step-number">02</p><h3>실행과 공유</h3><p>[기간 입력]</p><p class="detail">산출물 [중간 결과 입력]</p></article><article><p class="step-number">03</p><h3>검증과 인계</h3><p>[기간 입력]</p><p class="detail">산출물 [최종 결과 입력]</p></article></div><div class="budget"><div><p class="label">제안 예산</p><h2>[금액 · 통화 입력]</h2></div><div><h3>산출 근거와 전제</h3><p class="detail">[포함 범위 · 비용 기준 · 별도 항목 입력]</p><p class="detail">모든 금액과 기간은 입력란입니다.</p></div></div>','timeline-page'],
    ['오늘 결정할 사항을 정리합니다','<div class="decision-summary"><article class="meeting"><p class="label">합의 후 다음 행동</p><h2>다음 회의</h2><p>[일시 입력]</p><p class="detail">[참석자 · 준비할 자료 입력]</p></article><div class="decision-items"><article class="decision-item"><h3>범위 승인</h3><p>[진행할 내용과 제외할 내용 입력]</p></article><article class="decision-item"><h3>일정 합의</h3><p>[착수일 · 확인 일정 입력]</p></article><article class="decision-item"><h3>담당자 확정</h3><p>[의사결정자 · 실무 담당자 입력]</p></article></div></div><p class="note">합의한 내용은 담당자와 기한까지 함께 기록하세요.</p>','decision-page']
  ]}
};
