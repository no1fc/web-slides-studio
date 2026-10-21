import test from 'node:test';
import assert from 'node:assert/strict';
import pptxgen from 'pptxgenjs';
import JSZip from 'jszip';
import { finalizeEffectsPptx } from '../src/effects-export.js';
import { DOMParser } from 'linkedom';
test('effect targets use generated final shape IDs and slide transition order is valid',async()=>{
  const ppt=new pptxgen();const slide=ppt.addSlide();slide.addText('Target',{objectName:'target',x:1,y:1,w:2,h:1});
  const data=await finalizeEffectsPptx(await ppt.write({outputType:'nodebuffer'}),{order:['s0'],transitions:{s0:'push'},animations:{'a-target':'fade'}},[[{id:'a-target',name:'target'}]]);
  const xml=await(await JSZip.loadAsync(data)).file('ppt/slides/slide1.xml').async('string');
  const target=xml.match(/<p:cNvPr id="(\d+)" name="target"/)[1];assert.match(xml,new RegExp(`<p:spTgt spid="${target}"`));assert.match(xml,/<p:push dir="l"/);assert.match(xml,/<p:animEffect transition="in" filter="fade"/);
  const ids=[...xml.matchAll(/<p:cTn id="(\d+)"/g)].map(m=>m[1]);assert.equal(new Set(ids).size,ids.length);
  assert.ok(xml.indexOf('<p:transition')<xml.indexOf('<p:timing'));
});
test('timing belongs to slide root even when a shape contains an extension list and IDs contain double hyphens',async()=>{
  const ppt=new pptxgen();const slide=ppt.addSlide();slide.addText('Target',{objectName:'target',x:1,y:1,w:2,h:1});
  const zip=await JSZip.loadAsync(await ppt.write({outputType:'nodebuffer'}));const path='ppt/slides/slide1.xml';
  zip.file(path,(await zip.file(path).async('string')).replace('<p:nvPr/>','<p:nvPr><p:extLst><p:ext uri="test"/></p:extLst></p:nvPr>'));
  const data=await finalizeEffectsPptx(await zip.generateAsync({type:'nodebuffer'}),{order:['s0'],transitions:{s0:'fade'},animations:{'a-sales--q1':'appear'}},[[{id:'a-sales--q1',name:'target'}]]);
  const document=new DOMParser().parseFromString(await(await JSZip.loadAsync(data)).file(path).async('string'),'text/xml');
  const root=document.documentElement, names=[...root.children].map(n=>n.localName);
  assert.ok(names.includes('p:transition'));assert.ok(names.includes('p:timing'));assert.equal(root.querySelector('p\\:nvPr p\\:timing'),null);
});
