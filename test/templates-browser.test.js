import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {startStudio} from '../src/server.js';

test('built-in templates open through the editor and fit a notebook canvas',async()=>{
 const root=await mkdtemp(join(tmpdir(),'studio-template-fit-'));const app=await startStudio({root,port:0,contentPort:0});let browser;
 try {
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1366,height:768}});page.setDefaultTimeout(8000);
  for(const id of ['report','lecture','proposal']) {
   await page.goto(app.origin);await page.locator('#libraryTemplatesBtn').click();await page.locator('#template-'+id).click();await page.locator('#createFromTemplateBtn').click();await page.waitForFunction(()=>typeof frameReady!=='undefined'&&frameReady);
   const geometry=await page.frameLocator('#deckFrame').locator('#stage').evaluate(stage=>{const rect=stage.getBoundingClientRect();return {x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom,width:rect.width,height:rect.height,viewportWidth:innerWidth,viewportHeight:innerHeight,origin:getComputedStyle(stage).transformOrigin};});
   assert.equal(geometry.origin,'0px 0px',id);assert.ok(geometry.width>300&&geometry.width<1920,id);assert.ok(geometry.x>=-1&&geometry.y>=-1,id);assert.ok(geometry.right<=geometry.viewportWidth+1,JSON.stringify(geometry));assert.ok(geometry.bottom<=geometry.viewportHeight+1,JSON.stringify(geometry));
   assert.ok(await page.frameLocator('#deckFrame').locator('.slide.active h1').isVisible());
  }
 } finally {await browser?.close();await app.close();await rm(root,{recursive:true,force:true});}
});
