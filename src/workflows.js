import { readFile, readdir, mkdir, cp, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseHTML } from 'linkedom';
import { prepareDeck, renderDeck, validateState } from './deck.js';
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
      const html=`<!doctype html><html lang="ko"><head><title>${b.name}</title><style>html,body{margin:0;font-family:Arial,sans-serif;background:#f1f5f9;color:#172033}main{position:relative;width:1920px;height:1080px;transform-origin:0 0}.slide{position:absolute;inset:0;box-sizing:border-box;padding:120px;background:#fff;display:none}.slide.active{display:block}h1{font-size:88px;color:#2563eb}h2{font-size:64px}p,li{font-size:38px;line-height:1.6}.eyebrow{font-size:24px;letter-spacing:6px;color:#64748b}footer{position:absolute;bottom:65px;font-size:24px;color:#64748b}</style></head><body><main id="stage">${b.slides.map(([heading,text],i)=>`<section class="slide ${i?'':'active'}"><p class="eyebrow">${b.name} · ${i+1}</p><h1>${heading}</h1><p>${text}</p><footer>날짜 · 작성자</footer></section>`).join('')}</main></body></html>`;
      input=prepareDeck(html); input.files=new Map([['index.html',Buffer.from(input.html)]]);
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
const builtins={
  report:{name:'업무 보고서',slides:[['주간 업무 보고','핵심 성과와 다음 실행 계획을 공유합니다.'],['이번 주 핵심 성과','성과 1 · 달성 수치와 근거<br>성과 2 · 고객과 팀에 준 변화'],['현황과 해결 과제','현재 상황 → 원인 → 대응 방안을 정리하세요.'],['다음 단계','담당자 · 실행 과제 · 완료 예정일을 입력하세요.']]},
  lecture:{name:'강의 자료',slides:[['오늘 배울 내용','학습 목표와 활용할 상황을 소개하세요.'],['핵심 개념','개념을 한 문장으로 설명하고 쉬운 예시를 추가하세요.'],['함께 실습하기','1. 문제를 읽습니다.<br>2. 직접 해결합니다.<br>3. 결과를 함께 확인합니다.'],['정리와 질문','오늘의 핵심 세 가지와 다음 학습 과제를 안내하세요.']]},
  proposal:{name:'제안서',slides:[['더 나은 해결 방법','고객 이름 · 제안 제목 · 작성일'],['해결할 문제','현재의 어려움과 해결해야 하는 이유를 설명하세요.'],['제안 내용','핵심 해결책 · 기대 효과 · 실행 범위를 입력하세요.'],['일정과 예산','준비 → 실행 → 검증<br>단계별 일정, 담당자와 비용을 입력하세요.'],['다음 의사결정','승인할 범위와 다음 회의 일정을 정리하세요.']]}
};
