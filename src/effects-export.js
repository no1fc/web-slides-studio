import JSZip from 'jszip';
import { DOMParser } from 'linkedom';

// Build timing only for validated, generated objects. XML names/IDs are read
// from the final package so the background image cannot shift target IDs.
export async function finalizeEffectsPptx(buffer, state, mappings) {
  const zip = await JSZip.loadAsync(buffer);
  for (const [index, slideId] of state.order.entries()) {
    const path=`ppt/slides/slide${index+1}.xml`;
    let xml=await zip.file(path).async('string');
    const names=new Map([...xml.matchAll(/<p:cNvPr\b([^>]*)(?:\/>|>)/g)].map(match=>[match[1].match(/\bname="([^"]*)"/)?.[1],match[1].match(/\bid="(\d+)"/)?.[1]]));
    const transition=state.transitions?.[slideId];
    let extra=transition==='fade'?'<p:transition spd="med" advClick="1"><p:fade/></p:transition>':transition==='push'?'<p:transition spd="med" advClick="1"><p:push dir="l"/></p:transition>':'';
    let next=5; const effects=[], builds=[];
    for (const mapping of mappings[index] || []) {
      const effect=state.animations?.[mapping.rootId || mapping.id], id=names.get(mapping.name);
      if(!id || !['appear','fade'].includes(effect)) continue;
      const behavior=`<p:tgtEl><p:spTgt spid="${id}"/></p:tgtEl>`;
      const set=`<p:set><p:cBhvr><p:cTn id="${next++}" dur="1" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst></p:cTn>${behavior}<p:attrNameLst><p:attrName>style.visibility</p:attrName></p:attrNameLst></p:cBhvr><p:to><p:strVal val="visible"/></p:to></p:set>`;
      const fade=effect==='fade'?`<p:animEffect transition="in" filter="fade"><p:cBhvr><p:cTn id="${next++}" dur="500"/>${behavior}</p:cBhvr></p:animEffect>`:'';
      effects.push(`<p:par><p:cTn id="${next++}" presetID="${effect==='fade'?10:1}" presetClass="entr" presetSubtype="0" fill="hold" grpId="0" nodeType="withEffect"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${set}${fade}</p:childTnLst></p:cTn></p:par>`);
      if(mapping.kind==='chart') builds.push(`<p:bldGraphic spid="${id}" grpId="0"><p:bldAsOne/></p:bldGraphic>`);
      else if(!mapping.kind || mapping.kind==='text') builds.push(`<p:bldP spid="${id}" grpId="0"/>`);
    }
    // Match the sequence emitted by PowerPoint 16: two scheduling containers,
    // onBegin main-sequence condition and explicit previous/next conditions.
    if(effects.length) extra+=`<p:timing><p:tnLst><p:par><p:cTn id="1" dur="indefinite" restart="never" nodeType="tmRoot"><p:childTnLst><p:seq concurrent="1" nextAc="seek"><p:cTn id="2" dur="indefinite" nodeType="mainSeq"><p:childTnLst><p:par><p:cTn id="3" fill="hold"><p:stCondLst><p:cond delay="indefinite"/><p:cond evt="onBegin" delay="0"><p:tn val="2"/></p:cond></p:stCondLst><p:childTnLst><p:par><p:cTn id="4" fill="hold"><p:stCondLst><p:cond delay="0"/></p:stCondLst><p:childTnLst>${effects.join('')}</p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn></p:par></p:childTnLst></p:cTn><p:prevCondLst><p:cond evt="onPrev" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:prevCondLst><p:nextCondLst><p:cond evt="onNext" delay="0"><p:tgtEl><p:sldTgt/></p:tgtEl></p:cond></p:nextCondLst></p:seq></p:childTnLst></p:cTn></p:par></p:tnLst>${builds.length?`<p:bldLst>${builds.join('')}</p:bldLst>`:''}</p:timing>`;
    if(extra) {
      // CT_Slide ordering: cSld, clrMapOvr, transition, timing, extLst.
      const document=new DOMParser().parseFromString(xml,'text/xml'), root=document.documentElement;
      const extension=[...root.children].find(child=>child.localName==='p:extLst'||child.localName==='extLst') || null;
      const fragment=new DOMParser().parseFromString(`<root xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">${extra}</root>`,'text/xml');
      for(const node of [...fragment.documentElement.children]) root.insertBefore(node,extension);
      xml=document.toString();
      zip.file(path,xml);
    }
  }
  return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
