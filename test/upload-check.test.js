import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import '../public/upload-check.js';
import '../public/time.js';
const inspect = globalThis.SDUploadCheck.directory;
test('upload inspection checks expansion, unsafe paths, symlinks and unsupported packages before inflation', async () => {
  const zip = new JSZip(); zip.file('index.html','<section class="slide">Hello</section>');
  const bytes=await zip.generateAsync({type:'uint8array'});
  assert.equal(inspect(bytes,'zip').files.length,1);
  const large=bytes.slice(); const view=new DataView(large.buffer); const p=large.findIndex((_,i)=>view.byteLength>i+4&&view.getUint32(i,true)===0x02014b50);
  view.setUint32(p+24,65*1024*1024,true);
  assert.throws(()=>inspect(large,'zip'),/64/);
});
test('unsafe ZIP names and symlinks are rejected',async()=>{
  for(const [name,options] of [['../escape.html',{}],['link',{unixPermissions:0o120777}]]) {
    const zip=new JSZip();zip.file(name,'x',options);const bytes=await zip.generateAsync({type:'uint8array',platform:'UNIX'});
    assert.throws(()=>inspect(bytes,'zip'),/경로|링크/);
  }
});
test('time display is explicit Seoul time and never invents missing dates',()=>{
  assert.equal(globalThis.SDTime.format('2026-10-23T05:32:08.000Z',true),'2026-10-23 14:32:08 (KST)');
  assert.equal(globalThis.SDTime.format(null),'기록 없음');
});
