import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,symlink,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../src/store.js';
import {prepareDeck} from '../src/deck.js';
import {listAssets,uploadAsset,copyAsset,renameAsset,readAsset,deleteAsset,validateImage} from '../src/asset-library.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64');
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'assets-test-'));const store=new Store(root);await store.init();const input=prepareDeck('<html><body><section class="slide"><h1>Images</h1></section></body></html>');input.files=new Map([['index.html',Buffer.from(input.html)]]);const deck=await store.create(input);try{await fn(store,deck);}finally{await rm(root,{recursive:true,force:true});}}
test('asset names never overwrite, shared copies are independent and historical uses remain protected',()=>fixture(async(store,deck)=>{
 const a=await uploadAsset(store,null,{name:'Logo.png',bytes:png});const b=await uploadAsset(store,null,{name:'Logo.png',bytes:png});assert.notEqual(a.path,b.path);assert.equal(b.name,'Logo (2).png');assert.equal((await uploadAsset(store,null,{name:'Logo.png',bytes:png,collision:'skip'})).skipped,true);
 const copied=await copyAsset(store,null,deck.id,a.path);await renameAsset(store,deck.id,copied.path,'My logo.png');await deleteAsset(store,null,a.path);assert.deepEqual((await readAsset(store,deck.id,copied.path)).bytes,png);
 const next=structuredClone(deck.state);next.added.push({id:'a-img',slide:next.order[0],kind:'image',src:copied.path,x:0,y:0,w:100,h:100});await store.save(deck.id,1,next);const listed=await listAssets(store,deck.id);assert.equal(listed.files[0].name,'My logo.png');assert.equal(listed.files[0].canDelete,false);assert.equal(listed.files[0].usage[0].slide,next.order[0]);await assert.rejects(deleteAsset(store,deck.id,copied.path),/원본|저장 버전/);
 await store.save(deck.id,2,deck.state);assert.equal((await listAssets(store,deck.id)).files[0].canDelete,false);assert.deepEqual((await store.get(deck.id,2)).state.added,next.added);
}));
test('asset validation rejects disguised payloads, traversal, excessive bytes and symlink reads',()=>fixture(async(store,deck)=>{
 assert.throws(()=>validateImage('fake.png',Buffer.from('<script>bad()</script>')),/형식/);assert.throws(()=>validateImage('../bad.png',png),/이름/);assert.throws(()=>validateImage('huge.png',Buffer.alloc(12*1024*1024+1)),/12MB/);
 const a=await uploadAsset(store,null,{name:'ok.png',bytes:png});await assert.rejects(readAsset(store,null,'../meta.json'),/경로/);await assert.rejects(renameAsset(store,null,a.path,'../bad.png'),/이름/);
 const path=join(store.root,'_asset-library',a.path);await rm(path);await symlink(store.path(deck.id,'meta.json'),path);await assert.rejects(readAsset(store,null,a.path),/링크/);
 assert.equal((await readFile(store.path(deck.id,'meta.json'))).length>0,true);
}));
test('image API verifies authentication, binary response, safe copying and spoofed file rejection',async()=>{
 const {startStudio}=await import('../src/server.js');const root=await mkdtemp(join(tmpdir(),'asset-api-'));const app=await startStudio({root,port:0,contentPort:0,password:'assets-password-123'});
 try{
 const anonymous=await fetch(app.origin+'/api/asset-library');assert.equal(anonymous.status,401);
 const login=await fetch(app.origin+'/api/login',{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({password:'assets-password-123'})});assert.ok(login.ok);const cookie=login.headers.get('set-cookie').split(';')[0];
 const send=(path,method='GET',body)=>fetch(app.origin+'/api'+path,{method,headers:{Origin:app.origin,Cookie:cookie,...(body&&!Buffer.isBuffer(body)?{'Content-Type':'application/json'}:{})},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
 assert.equal((await send('/asset-library?name=evil.png','POST',Buffer.from('not an image'))).status,400);
 const uploaded=await send('/asset-library?name=test.png','POST',png);assert.equal(uploaded.status,201);const a=await uploaded.json();const binary=await send('/asset-library?path='+encodeURIComponent(a.path));assert.equal(binary.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await binary.arrayBuffer()),png);
 const input=prepareDeck('<html><body><section class="slide"><h1>Target</h1></section></body></html>');input.files=new Map([['index.html',Buffer.from(input.html)]]);const d=await app.store.create(input);
 const copied=await send(`/decks/${d.id}/asset-library?copy=1`,'POST',{fromDeckId:null,path:a.path});assert.equal(copied.status,201);const b=await copied.json();await send('/asset-library','DELETE',{path:a.path});assert.equal((await send(`/decks/${d.id}/asset-library?path=`+encodeURIComponent(b.path))).status,200);
 assert.equal((await send('/asset-library?copy=1','POST',{fromDeckId:'../../',path:b.path})).status,400);
 assert.equal((await fetch(app.origin+'/_asset-library/'+a.path)).status,404);
 }finally{await app.close();await rm(root,{recursive:true,force:true});}
});
test('font and SVG assets preserve independent bytes while rejecting active SVG and malformed fonts',()=>fixture(async(store,deck)=>{
 const {validateAsset}=await import('../src/asset-library.js');const font=await readFile(new URL('../public/editor-geist.woff2',import.meta.url));assert.equal(validateAsset('Geist.woff2',font),'font/woff2');
 const svg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="a"><stop offset="0" stop-color="#f00"/></linearGradient></defs><path fill="url(#a)" d="M0 0H64V64H0Z"/></svg>');assert.equal(validateAsset('Logo.svg',svg),'image/svg+xml');
 for(const body of ['<script>alert(1)</script>','<foreignObject><div>bad</div></foreignObject>','<image href="https://example.com/x.png"/>','<path onclick="alert(1)"/>','<use href="&#x68;ttps://example.com/x.svg#x"/>','<path style="fill:red"/>','<animate attributeName="href" values="javascript:alert(1)"/>'])assert.throws(()=>validateAsset('bad.svg',Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`)),/SVG/);
 const corrupt=Buffer.from(font);corrupt.writeUInt32BE(corrupt.length+100,8);assert.throws(()=>validateAsset('bad.woff2',corrupt),/폰트/);assert.throws(()=>validateAsset('bad.ttf',Buffer.from('OTTO'+'.'.repeat(100))),/폰트/);
 for(const [name,bytes]of [['Geist.woff2',font],['Logo.svg',svg]]){const shared=await uploadAsset(store,null,{name,bytes});const copied=await copyAsset(store,null,deck.id,shared.path);await deleteAsset(store,null,shared.path);assert.deepEqual((await readAsset(store,deck.id,copied.path)).bytes,bytes);}
 assert.equal((await listAssets(store,deck.id)).files.length,2);
}));
