import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startStudio} from '../src/server.js';

test('practical builtins have varied layouts, bounded editable text, theme support and persistent visual editing',async()=>{
 const root=await mkdtemp(join(tmpdir(),'studio-builtin-layouts-'));const app=await startStudio({root,port:0,contentPort:0});let browser;
 const screenshots='/tmp/slides-builtin-layouts';await mkdir(screenshots,{recursive:true});
 try {
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1920,height:1080}});page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',error=>errors.push(error.message));
  let report;
  for(const [id,count] of [['report',4],['lecture',4],['proposal',5]]) {
   const response=await fetch(app.origin+'/api/templates/'+id+'/create',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:'{}'});assert.equal(response.status,201);const deck=await response.json();if(id==='report')report=deck;
   assert.equal(deck.slides.length,count);assert.equal(Object.keys(deck.state.slideLayouts).length,count);
   const source=await readFile(app.store.path(deck.id,'assets/index.html'),'utf8');assert.ok(!/https?:\/\//.test(source));
   await page.goto(deck.previewUrl);await page.waitForFunction(()=>!!window.__sd);await page.evaluate(()=>document.fonts.ready);
   const layouts=await page.locator('.slide').evaluateAll(slides=>slides.map(slide=>[...slide.classList].filter(name=>!['slide','active'].includes(name)).join(' ')));assert.equal(new Set(layouts).size,count);
   for(let index=0;index<count;index++) {
    await page.evaluate(index=>window.__sd.go(index),index);
    const issues=await page.locator('.slide.active').evaluate(slide=>{
      const bounds=slide.getBoundingClientRect(),issues=[];
      for(const node of slide.querySelectorAll('[data-sd-id]')){
       const box=node.getBoundingClientRect();if(!box.width||!box.height||getComputedStyle(node).display==='none')continue;
       if(box.left<bounds.left-1||box.top<bounds.top-1||box.right>bounds.right+1||box.bottom>bounds.bottom+1)issues.push({id:node.dataset.sdId,text:node.textContent,outside:true});
       if(node.scrollWidth>node.clientWidth+2||node.scrollHeight>node.clientHeight+2)issues.push({id:node.dataset.sdId,text:node.textContent,overflow:true,client:[node.clientWidth,node.clientHeight],scroll:[node.scrollWidth,node.scrollHeight],font:getComputedStyle(node).font});
      }
      return issues;
    });assert.deepEqual(issues,[],id+' slide '+(index+1));
    await page.screenshot({path:join(screenshots,`${id}-${index+1}.png`)});
   }
  }
  await page.setViewportSize({width:1366,height:768});await page.goto(app.origin+'/#deck='+report.id);await page.waitForFunction(()=>frameReady);
  const heading=page.frameLocator('#deckFrame').locator('.slide.active .page-heading');const headingId=await heading.getAttribute('data-sd-id');await heading.dblclick();await page.keyboard.press('Control+a');await page.keyboard.insertText('팀 운영 주간 보고');
  const saved=page.waitForResponse(r=>r.url().endsWith('/save')&&r.request().method()==='POST');await page.locator('#boldTextBtn').click();await saved;await page.waitForFunction(()=>!dirty&&!saving);
  await page.reload();await page.waitForFunction(()=>frameReady);assert.match(await page.frameLocator('#deckFrame').locator('.slide.active .page-heading').innerText(),/팀 운영 주간 보고/);assert.match((await app.store.get(report.id)).state.patches[headingId].text,/팀 운영 주간 보고/);
  // Individual formatting survives brand changes; check inheritance on a fresh template.
  const freshResponse=await fetch(app.origin+'/api/templates/report/create',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:'{}'});assert.equal(freshResponse.status,201);const fresh=await freshResponse.json();
  const current=await app.store.get(fresh.id),state=structuredClone(current.state);state.theme={colors:{background:'#18242c',text:'#f6f3ea',accent:'#f2b26b'},fonts:{heading:'Arial',body:'Arial'}};const branded=await app.store.save(fresh.id,current.revision,state);
  await page.setViewportSize({width:1920,height:1080});await page.goto(fresh.previewUrl.replace('rev=1','rev='+branded.revision));await page.waitForFunction(()=>!!window.__sd);
  const colors=await page.locator('.slide.active').evaluate(slide=>({background:getComputedStyle(slide).backgroundColor,text:getComputedStyle(slide.querySelector('.page-heading')).color,accent:getComputedStyle(slide.querySelector('.page-header p')).color}));assert.deepEqual(colors,{background:'rgb(24, 36, 44)',text:'rgb(246, 243, 234)',accent:'rgb(242, 178, 107)'});
  await page.screenshot({path:join(screenshots,'report-brand.png')});assert.deepEqual(errors,[]);
 } finally {await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
});
