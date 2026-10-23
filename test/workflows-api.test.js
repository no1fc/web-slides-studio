import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
import {startStudio} from '../src/server.js';
import {exportDeck} from '../src/export.js';
const note='CONFIDENTIAL-SPEAKER-ONLY-917';
const escapedNote=note.split('').map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
async function setup(t){
 const root=await mkdtemp(join(tmpdir(),'studio-workflows-'));const app=await startStudio({port:0,contentPort:0,root});t.after(()=>app.close());
 const post=async(path,data)=>{const r=await fetch(app.origin+path,{method:'POST',headers:{Origin:app.origin,'Content-Type':'application/json'},body:JSON.stringify(data)});const result=await r.json();return {status:r.status,...result};};
 const zip=new JSZip();zip.file('index.html',`<html><head><title>Report</title><script>const speakerNotes = ${String.fromCharCode(96)}${note}${String.fromCharCode(96)}; const escapedNotes="${escapedNote}";</script></head><body><main><section class="slide"><h1>First</h1><aside class="notes">${note}</aside></section><section class="slide"><h1>Second</h1></section></main></body></html>`);zip.file('extra.html',`<html><body><aside class="notes">${note}</aside></body></html>`);zip.file('data.json',JSON.stringify({speaker:note}));zip.file('speaker.js',`const speakerNotes = \`${note}\`; const escapedNotes="${escapedNote}";`);zip.file('BACKUP.HTML',`<html><body><aside class="notes">${note}</aside></body></html>`);zip.file('assets/logo.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmS0AAAAASUVORK5CYII=','base64'));
 const bytes=await zip.generateAsync({type:'nodebuffer'});const key=createHash('sha256').update(bytes).digest('hex');
 const upload=()=>fetch(app.origin+'/api/decks',{method:'POST',headers:{Origin:app.origin,'X-Import-Key':key},body:bytes}).then(r=>r.json());const deck=await upload();return {app,post,deck,root,upload};
}
test('new shares omit actual notes, protect all assets, expire and revoke; old shares retain explicit compatibility',async t=>{
 const {app,post,deck,root}=await setup(t),path=`/api/decks/${deck.id}`;
 const shared=await post(path+'/publish',{enabled:true});assert.equal(shared.shareIncludeNotes,false);assert.ok(shared.publishedAt);assert.equal(shared.createdAt,deck.createdAt);
 const publicHtml=await (await fetch(shared.shareUrl)).text();assert.ok(!publicHtml.includes(note));assert.ok(!publicHtml.includes(escapedNote));const script=await(await fetch(new URL('speaker.js',shared.shareUrl))).text();assert.ok(!script.includes(note));assert.ok(!script.includes(escapedNote));assert.ok(!(await (await fetch(new URL('data.json',shared.shareUrl))).text()).includes(note));assert.equal((await fetch(new URL('BACKUP.HTML',shared.shareUrl))).status,404);
 const audience=await(await fetch(deck.previewUrl+'&mode=audience')).text();assert.ok(!audience.includes(note));assert.ok(!audience.includes(deck.previewToken));assert.equal((await fetch(deck.audienceUrl.replace('/a/','/v/'))).status,404);assert.equal((await fetch(deck.previewUrl.replace('/v/','/a/'))).status,404);assert.equal((await fetch(deck.audienceUrl+'&mode=edit')).status,200);const audienceAsset=new URL('data.json',deck.audienceUrl);assert.ok(!(await(await fetch(audienceAsset)).text()).includes(note));
 const protectedDeck=await post(path+'/publish',{enabled:true,password:'test-secret'});assert.ok(protectedDeck.sharePasswordProtected);assert.equal(protectedDeck.sharePassword,undefined);
 const raw=await readFile(join(root,deck.id,'meta.json'),'utf8');assert.ok(!raw.includes('test-secret'));assert.match(raw,/sharePassword/);
 assert.equal((await fetch(protectedDeck.shareUrl)).status,401);const asset=new URL('assets/logo.png',protectedDeck.shareUrl);assert.equal((await fetch(asset)).status,401);
 const unlock=new URL('unlock',protectedDeck.shareUrl);const bad=await fetch(unlock,{method:'POST',headers:{Origin:app.contentOrigin},body:new URLSearchParams({password:'wrong'}),redirect:'manual'});assert.equal(bad.status,401);
 const good=await fetch(unlock,{method:'POST',headers:{Origin:app.contentOrigin},body:new URLSearchParams({password:'test-secret'}),redirect:'manual'});assert.equal(good.status,303);const cookie=good.headers.get('set-cookie').split(';')[0];assert.equal((await fetch(asset,{headers:{Cookie:cookie}})).status,200);
 const republished=await post(path+'/publish',{enabled:true});assert.equal(republished.sharePasswordProtected,true);assert.equal(republished.shareUrl,protectedDeck.shareUrl);assert.equal(republished.createdAt,deck.createdAt);assert.equal(republished.updatedAt,deck.updatedAt);assert.notEqual(republished.publishedAt,protectedDeck.publishedAt);assert.equal((await fetch(asset,{headers:{Cookie:cookie}})).status,401);
 const expired=await app.store.meta(deck.id);expired.shareExpiresAt='2000-01-01T00:00:00.000Z';await app.store.atomic(app.store.path(deck.id,'meta.json'),expired);assert.equal((await fetch(asset,{headers:{Cookie:cookie}})).status,410);
 await post(path+'/publish',{enabled:false});assert.equal((await fetch(asset,{headers:{Cookie:cookie}})).status,404);
 const legacy=await app.store.meta(deck.id);legacy.shareToken='a'.repeat(48);legacy.publishedRevision=1;delete legacy.shareIncludeNotes;delete legacy.shareExpiresAt;await app.store.atomic(app.store.path(deck.id,'meta.json'),legacy);assert.ok((await(await fetch(app.contentOrigin+`/v/${deck.id}/${legacy.shareToken}/index.html`)).text()).includes(note));
 const listed=await(await fetch(app.origin+path)).json();assert.equal(listed.shareLegacyNotes,true);
});
test('notes policy removes secrets from every HTML ZIP member while opt-in remains',async t=>{
 const {app,deck}=await setup(t);
 for(const includeNotes of [false,true]){const out=await exportDeck({store:app.store,deck:await app.store.get(deck.id),format:'html',includeNotes});const zip=await JSZip.loadAsync(out.buffer);let all='';for(const file of Object.values(zip.files))if(!file.dir)all+=await file.async('string');assert.equal(all.includes(note),includeNotes);assert.equal(all.includes(escapedNote),includeNotes);}
});
test('AI staging does not save; selection applies one slide, conflicts, reject and restore preserve history and timestamps',async t=>{
 const {app,post,deck}=await setup(t),path=`/api/decks/${deck.id}`;const state=structuredClone(deck.state);state.patches.e0={text:'AI first'};state.patches.e1={text:'AI second'};
 const proposal=await post(path+'/proposals',{revision:1,state,summary:'두 제목 개선'});assert.equal(proposal.status,'pending');assert.equal((await app.store.get(deck.id)).revision,1);
 assert.match(await(await fetch(proposal.afterUrl)).text(),/AI first/);assert.ok(!(await(await fetch(proposal.beforeUrl)).text()).includes('AI first'));
 const applied=await post(path+`/proposals/${proposal.id}/apply`,{revision:1,slides:['s0']});assert.equal(applied.revision,2);assert.equal(applied.state.patches.e0.text,'AI first');assert.equal(applied.state.patches.e1,undefined);assert.equal(applied.createdAt,deck.createdAt);
 const p2=await post(path+'/proposals',{revision:2,state,summary:'두 번째 제안'});await post(path+'/save',{revision:2,state:applied.state});const conflict=await post(path+`/proposals/${p2.id}/apply`,{revision:2,slides:['s1']});assert.equal(conflict.status,409);
 await post(path+`/proposals/${p2.id}/reject`,{});const restored=await post(path+'/restore',{revision:3,target:1});assert.equal(restored.revision,4);assert.deepEqual(restored.state.patches,{});
 const named=await post(path+'/revision-name',{revision:2,name:'검토 완료'});assert.equal(named[2].name,'검토 완료');
 const history=await(await fetch(app.origin+path+'/revisions')).json();assert.equal(history[0].source,'restore');assert.equal(history[2].source,'ai');assert.equal(history[3].source,undefined);assert.ok(history.every(h=>h.savedAt.endsWith('Z')));
});
test('template assets and brand logos copy independently; repeated upload is idempotent; MCP reports are actual bounded data',async t=>{
 const {app,post,deck,upload}=await setup(t);assert.equal((await upload()).id,deck.id);
 const template=await post('/api/templates',{deckId:deck.id,name:'Saved deck'});const copy=await post(`/api/templates/${template.id}/create`,{title:'Independent'});assert.notEqual(copy.id,deck.id);assert.equal(copy.title,'Independent');assert.deepEqual(await readFile(app.store.path(copy.id,'assets/assets/logo.png')),await readFile(app.store.path(deck.id,'assets/assets/logo.png')));
 const state=structuredClone(copy.state);state.patches.e0={text:'Independent edit'};await post(`/api/decks/${copy.id}/save`,{revision:1,state});assert.deepEqual((await app.store.get(deck.id)).state.patches,{});
 for(const name of ['report','lecture','proposal']) {const built=await post(`/api/templates/${name}/create`,{});assert.equal(built.revision,1);assert.ok(built.slides.length>=4);}
 const brand=await post('/api/brands',{name:'My brand',font:'Arial',colors:{background:'#ffffff',text:'#112233',accent:'#ff0033'},deckId:deck.id,logo:'assets/logo.png'});assert.ok(brand.id);
 const branded=await post(`/api/brands/${brand.id}/apply`,{deckId:deck.id,revision:1});assert.equal(branded.revision,2);assert.equal(branded.state.theme.colors.accent,'#ff0033');assert.equal(branded.state.added.length,2);
 const report=await post('/api/ai-connection',{version:'0.3.0',client:'codex',platform:'linux',checks:{server:'ok',authentication:'ok',tools:'ok',workspace:'error'},password:'should-not-store'});assert.equal(report.report.checks.workspace,'error');assert.ok(report.report.reportedAt.endsWith('Z'));assert.ok(!JSON.stringify(report).includes('should-not-store'));
});

test('PPTX notes are physically absent on opt-out',async t=>{
 const {app,deck}=await setup(t);
 const result=await exportDeck({store:app.store,deck:await app.store.get(deck.id),format:'pptx',url:deck.previewUrl+'&omitNotes=1',contentOrigin:app.contentOrigin,includeNotes:false});
 const zip=await JSZip.loadAsync(result.buffer);for(const file of Object.values(zip.files)) if(!file.dir&&file.name.endsWith('.xml')) assert.ok(!(await file.async('string')).includes(note),file.name);
});
test('selective AI applies authored object patches and explains new-slide order dependencies',async t=>{
 const {app,post,deck}=await setup(t),path=`/api/decks/${deck.id}`;
 let state=structuredClone(deck.state);state.slideCode.s0={html:'<h1 data-sd-id="e0">Authored title</h1>',css:''};const saved=await post(path+'/save',{revision:1,state});
 const objectId=/data-sd-id="([^"]+)"/.exec(saved.state.slideCode.s0.html)[1];state=structuredClone(saved.state);state.patches[objectId]={text:'Selected authored edit'};state.patches.e1={text:'Leave unchanged'};
 const proposal=await post(path+'/proposals',{revision:2,state});const applied=await post(path+`/proposals/${proposal.id}/apply`,{revision:2,slides:['s0']});assert.equal(applied.revision,3);assert.equal(applied.state.patches[objectId].text,'Selected authored edit');assert.equal(applied.state.patches.e1,undefined);
 state=structuredClone(applied.state);state.clones['s-copy']='s0';state.order.push('s-copy');
 const added=await post(path+'/proposals',{revision:3,state});const invalid=await post(path+`/proposals/${added.id}/apply`,{revision:3,slides:['__global__']});assert.equal(invalid.status,400);assert.match(invalid.error,/새로 추가된 슬라이드/);assert.equal((await app.store.get(deck.id)).revision,3);
});
test('excluding notes preserves matching visible words and strips authored note containers',async()=>{
 const {withoutNotesHtml,withoutNotesState}=await import('../src/notes-policy.js');
 const html=withoutNotesHtml('<html><body><h1>a</h1><aside class="notes">a</aside><script>const a=1;const notes="a";</script></body></html>',{state:{notes:{s0:'a'}},slides:[]});assert.match(html,/<h1>a<\/h1>/);assert.match(html,/const a=1/);assert.ok(!html.includes('class="notes"'));assert.match(html,/notes=""/);
 const state=withoutNotesState({notes:{s0:'secret'},added:[{html:'<p>Visible</p><aside class="notes">secret</aside>'}],slideCode:{},masters:{}});assert.ok(!JSON.stringify(state).includes('secret'));
});

test('AI detects effects without visual HTML differences and never applies unselected effects',async t=>{
 const {app,post,deck}=await setup(t),path=`/api/decks/${deck.id}`;
 let state=structuredClone(deck.state);state.transitions.s1='fade';let proposal=await post(path+'/proposals',{revision:1,state});assert.ok(proposal.changes.some(c=>c.slide==='s1'));assert.deepEqual(proposal.beforeOrder,deck.state.order);
 state.patches.e0={text:'Only choose this title'};proposal=await post(path+'/proposals',{revision:1,state});assert.ok(proposal.changes.some(c=>c.slide==='s0'));assert.ok(proposal.changes.some(c=>c.slide==='s1'));
 const applied=await post(path+`/proposals/${proposal.id}/apply`,{revision:1,slides:['s0']});assert.equal(applied.revision,2);assert.equal(applied.state.transitions.s1,undefined);assert.equal(applied.state.patches.e0.text,'Only choose this title');
 state=structuredClone(applied.state);state.added.push({id:'a-animated',slide:'s1',kind:'text',text:'Animated',x:100,y:100,w:600,h:200});const saved=await post(path+'/save',{revision:2,state,source:'manual'});state=structuredClone(saved.state);state.animations['a-animated']='fade';proposal=await post(path+'/proposals',{revision:3,state});assert.deepEqual(proposal.changes.map(c=>c.slide),['s1']);const animated=await post(path+`/proposals/${proposal.id}/apply`,{revision:3,slides:['s1']});assert.equal(animated.state.animations['a-animated'],'fade');
 const history=await(await fetch(app.origin+path+'/revisions')).json();assert.equal(history[1].source,'manual');
});
test('nested interpolated templates redact raw and escaped notes in real audience, share and ZIP responses',async t=>{
 const {app,post}=await setup(t);const secret='CONFIDENTIAL-BUDGET-917',escaped=secret.split('').map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');
 const script='const punctuation = /["\']/; const notes = `${`'+secret+'`}`; const conditional = `${true ? `'+escaped+'` : `${"'+secret+'"}`}`;';
 const archive=new JSZip();archive.file('index.html','<html><head><script>'+script+'</script></head><body><section class="slide"><h1>Keep the slide</h1><aside class="notes">'+secret+'</aside></section></body></html>');archive.file('nested.js',script);
 const response=await fetch(app.origin+'/api/decks',{method:'POST',headers:{Origin:app.origin},body:await archive.generateAsync({type:'nodebuffer'})});const deck=await response.json();const shared=await post(`/api/decks/${deck.id}/publish`,{enabled:true});
 for(const url of [shared.shareUrl,deck.audienceUrl,new URL('nested.js',shared.shareUrl),new URL('nested.js',deck.audienceUrl)]){const r=await fetch(url);assert.equal(r.status,200);const text=await r.text();assert.ok(!text.includes(secret),String(url));assert.ok(!text.includes(escaped),String(url));}
 const output=await exportDeck({store:app.store,deck:await app.store.get(deck.id),format:'html',includeNotes:false});const zip=await JSZip.loadAsync(output.buffer);for(const name of ['index.html','nested.js']){const text=await zip.file(name).async('string');assert.ok(!text.includes(secret));assert.ok(!text.includes(escaped));}
 const sanitized=await(await fetch(new URL('nested.js',shared.shareUrl))).text();new Function(sanitized);assert.match(sanitized,/punctuation/);
});
test('repeated note matches merge intervals without quadratic redaction',async()=>{
 const {redactNoteText}=await import('../src/notes-policy.js');
 const text='const a=1;const note="'+'a'.repeat(1024*1024)+'";';const start=performance.now();const result=redactNoteText(text,{state:{notes:{s0:'a'}},slides:[]});const elapsed=performance.now()-start;
 assert.equal(result,'const a=1;const note="";');assert.ok(elapsed<2000,`1 MiB redaction took ${elapsed}ms`);
});
test('known notes in regex literals fail closed while unrelated regex survives',async t=>{
 const {redactNoteText}=await import('../src/notes-policy.js');const secret='CONFIDENTIAL-BUDGET-917',escaped=secret.split('').map(c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0')).join('');const noteDeck={state:{notes:{s0:secret}},slides:[]};
 const safe='const punctuation=/["\']/; const fraction=12/3;';assert.equal(redactNoteText(safe,noteDeck),safe);
 for(const code of ['const notes=/'+secret+'/;','if(true) /'+secret+'/.test("x");','const notes=/'+escaped+'/;'])assert.throws(()=>redactNoteText(code,noteDeck),/정규식/);
 const {app,post}=await setup(t);const archive=new JSZip();archive.file('index.html','<html><head><script>if(true) /'+secret+'/.test("x");</script></head><body><section class="slide"><h1>Visible</h1><aside class="notes">'+secret+'</aside></section></body></html>');archive.file('regex.js','const notes=/'+escaped+'/;');
 const response=await fetch(app.origin+'/api/decks',{method:'POST',headers:{Origin:app.origin},body:await archive.generateAsync({type:'nodebuffer'})});const deck=await response.json();const shared=await post(`/api/decks/${deck.id}/publish`,{enabled:true});
 for(const url of [shared.shareUrl,deck.audienceUrl,new URL('regex.js',shared.shareUrl)]){const response=await fetch(url);assert.equal(response.status,400);const text=await response.text();assert.ok(!text.includes(secret));assert.ok(!text.includes(escaped));assert.match(text,/정규식/);}
 await assert.rejects(exportDeck({store:app.store,deck:await app.store.get(deck.id),format:'html',includeNotes:false}),/정규식/);
});
