import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';
import { startStudio } from '../src/server.js';
import { prepareDeck } from '../src/deck.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'studio-iframe-'));
  const app = await startStudio({root, port:0, contentPort:0});
  t.after(async () => { await app.close(); await rm(root,{recursive:true,force:true}); });
  const create = async () => {
    const input = prepareDeck('<html><head><title>Embedding test</title></head><body><section class="slide"><h1>Shared presentation</h1></section></body></html>');
    input.files = new Map([['index.html',Buffer.from(input.html)]]);
    const d = await app.store.create(input);
    return (await fetch(app.origin+`/api/decks/${d.id}`)).json();
  };
  const deck = await create();
  const publish = async (options, id=deck.id) => {
    const r = await fetch(app.origin+`/api/decks/${id}/publish`,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify({enabled:true,...options})});
    return {status:r.status,body:await r.json()};
  };
  const ancestors = async url => (await fetch(url)).headers.get('content-security-policy')?.match(/frame-ancestors ([^;]+)/)?.[1];
  return {app,deck,create,publish,ancestors};
}

test('per-deck origins persist, normalize and affect only public shares including thumbnails', async t => {
  const {app,deck,create,publish,ancestors} = await fixture(t);
  const shared = await publish({embedOrigins:['https://PORTAL.example:443/','https://portal.example','http://localhost:8080']});
  assert.equal(shared.status,200);
  assert.deepEqual(shared.body.shareEmbedOrigins,['https://portal.example','http://localhost:8080']);
  assert.deepEqual((await app.store.get(deck.id)).shareEmbedOrigins,shared.body.shareEmbedOrigins);
  const expected = app.origin+' https://portal.example http://localhost:8080';
  assert.equal(await ancestors(shared.body.shareUrl),expected);
  assert.equal(await ancestors(shared.body.shareUrl+'?mode=thumbnail&slide=s0'),expected);
  for (const url of [deck.previewUrl,deck.audienceUrl,deck.previewUrl+'&mode=thumbnail&slide=s0']) assert.equal(await ancestors(url),app.origin);
  const other = await create();
  const otherShare = await publish({},other.id);
  assert.equal(await ancestors(otherShare.body.shareUrl),app.origin);
  const retained = await publish({});
  assert.deepEqual(retained.body.shareEmbedOrigins,shared.body.shareEmbedOrigins);
  const copy = await app.store.duplicate(deck.id);
  assert.deepEqual(copy.shareEmbedOrigins,[]);
  const cleared = await publish({embedOrigins:[]});
  assert.equal(cleared.body.shareUrl,shared.body.shareUrl);
  assert.equal(await ancestors(cleared.body.shareUrl),app.origin);
});

test('invalid origins and header injection fail without changing the existing share', async t => {
  const {app,deck,publish} = await fixture(t);
  await publish({embedOrigins:['https://allowed.example']});
  const before = await app.store.meta(deck.id);
  for (const embedOrigins of [null,'https://allowed.example',{},[42],['*'],['https://*.example'],['javascript:alert(1)'],['data:text/html,hello'],['https://user:pass@example.com'],['https://example.com/path'],['https://example.com?x=1'],['https://example.com#x'],['https://example.com;'],['http://[::1]:8080'],Array.from({length:20},(_,i)=>'https://'+String(i)+'a'.repeat(105)+'.example'),['https://example.com\r\nX-Test: bad'],['https://exa\tmple.com'],['https://example.com\\'],['https://example.com\u0000'],Array(21).fill('https://example.com'),['https://'+ 'a'.repeat(2050)+'.com']]) {
    assert.equal((await publish({embedOrigins})).status,400,JSON.stringify(embedOrigins));
    assert.deepEqual(await app.store.meta(deck.id),before);
  }
});

test('password shares cannot silently accept iframe settings and can switch explicitly', async t => {
  const {publish,ancestors} = await fixture(t);
  let r = await publish({password:'test-password'});
  assert.equal(r.status,200);
  assert.equal(await ancestors(r.body.shareUrl),"'none'");
  assert.equal((await publish({embedOrigins:['https://portal.example']})).status,400);
  r = await publish({password:null,embedOrigins:['https://portal.example']});
  assert.equal(r.status,200);
  assert.equal(r.body.sharePasswordProtected,false);
  assert.equal((await publish({password:'test-password'})).status,400);
  assert.equal((await publish({password:'test-password',embedOrigins:[]})).status,200);
});

test('iframe shares still expire and revoke, including their assets', async t => {
  const {app,deck,publish} = await fixture(t);
  const shared = await publish({embedOrigins:['https://portal.example']});
  const meta = await app.store.meta(deck.id);
  meta.shareExpiresAt='2000-01-01T00:00:00.000Z';
  await app.store.atomic(app.store.path(deck.id,'meta.json'),meta);
  assert.equal((await fetch(shared.body.shareUrl)).status,410);
  await publish({enabled:false});
  assert.equal((await fetch(shared.body.shareUrl)).status,404);
});

test('Chromium permits the selected external parent and blocks other parents and private previews', async t => {
  const {app,deck,publish} = await fixture(t);
  const browser = await chromium.launch({executablePath:process.env.CHROME_PATH||'/usr/bin/google-chrome',args:['--no-sandbox']});
  t.after(()=>browser.close());
  // Real loopback parents avoid Chromium's public-to-local network block on mocked responses.
  async function parentServer() {
    const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<iframe src="${new URL(req.url,'http://localhost').searchParams.get('target')}"></iframe>`);});
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
    return `http://127.0.0.1:${server.address().port}`;
  }
  const allowed = await parentServer(), blocked = await parentServer();
  const shared = await publish({embedOrigins:[allowed]});
  assert.equal(shared.status,200);
  async function embedded(parent,target,shouldLoad) {
    const page = await browser.newPage();
    try {
      const errors=[];
      page.on('console',msg=>{if(msg.text().includes('frame-ancestors'))errors.push(msg.text());});
      await page.goto(parent+'/iframe-test?target='+encodeURIComponent(target),{waitUntil:'networkidle'});
      const frame=page.frames().find(f=>f.url().startsWith(app.contentOrigin+'/v/'));
      const loaded=frame?await frame.locator('#sd-config').count()>0:false;
      assert.equal(loaded,shouldLoad,`${parent}: ${new URL(target).search}`);
      assert.equal(errors.length>0,!shouldLoad);
    } finally {await page.close();}
  }
  await embedded(allowed,shared.body.shareUrl,true);
  await embedded(blocked,shared.body.shareUrl,false);
  await embedded(allowed,deck.previewUrl,false);
  await publish({embedOrigins:[]});
  await embedded(allowed,shared.body.shareUrl,false);
});
