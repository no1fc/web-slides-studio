import {mkdir,readFile,writeFile,rm,realpath,lstat} from 'node:fs/promises';
import {join,resolve,extname,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {inventory} from './files.js';
import {renderDeck} from './deck.js';
import {parseHTML, DOMParser} from 'linkedom';
const types={'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf'};
function assetName(name){if(typeof name!=='string'||!name.trim()||name.length>180||/[\\/\x00-\x1f\x7f]/.test(name)||name==='.'||name==='..')throw new Error('파일 이름을 확인해 주세요. 경로는 이름에 사용할 수 없습니다.');return name.trim();}
export function validateImage(name,bytes){assetName(name);const ext=extname(name).toLowerCase();if(!Buffer.isBuffer(bytes)||bytes.length>12*1024*1024)throw new Error('이미지는 12MB 이하로 올려 주세요.');const match=ext==='.png'?bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR':ext==='.jpg'||ext==='.jpeg'?bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255:ext==='.gif'?bytes.length>=13&&/^GIF8[79]a$/.test(bytes.toString('ascii',0,6)):ext==='.webp'?bytes.length>=16&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP':false;if(!match)throw new Error('파일 내용과 이미지 형식이 맞지 않습니다. PNG/JPG/WebP/GIF 이미지로 다시 저장해 주세요.');return types[ext];}
const svgTags=new Set('svg g path rect circle ellipse line polyline polygon defs clipPath mask linearGradient radialGradient stop title desc text tspan use symbol'.toLowerCase().split(' '));
const svgAttrs=new Set('xmlns xmlns:xlink id viewBox width height x y x1 x2 y1 y2 cx cy r rx ry d points fill fill-rule fill-opacity stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit stroke-dasharray stroke-dashoffset stroke-opacity opacity transform gradientTransform gradientUnits spreadMethod offset stop-color stop-opacity clip-path clip-rule clipPathUnits mask maskUnits maskContentUnits preserveAspectRatio href xlink:href font-size font-family font-weight text-anchor dominant-baseline role aria-label aria-hidden focusable version'.toLowerCase().split(' '));
export function validateSvg(bytes){
 if(bytes.length>1024*1024)throw new Error('SVG는 1MB 이하로 줄여 주세요.');
 let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('SVG는 UTF-8 형식이어야 합니다.');}
 if(/<!DOCTYPE|<!ENTITY|<\?(?!xml\s)|<\?xml-stylesheet/i.test(text))throw new Error('SVG의 외부 문서·처리 명령은 지원하지 않습니다.');
 const document=new DOMParser().parseFromString(text,'image/svg+xml'),root=document.documentElement;
 if(!root||root.localName.toLowerCase()!=='svg'||root.getAttribute('xmlns')!=='http://www.w3.org/2000/svg')throw new Error('올바른 SVG 이미지가 아닙니다.');
 for(const key of ['width','height']){const value=root.getAttribute(key);if(value&&!value.endsWith('%')&&(!Number.isFinite(parseFloat(value))||parseFloat(value)<=0||parseFloat(value)>8192))throw new Error('SVG 크기는 8192 이하로 줄여 주세요.');}
 const all=[root,...root.querySelectorAll('*')];if(all.length>10000)throw new Error('SVG 요소가 너무 많습니다. 단순화하거나 PNG로 저장해 주세요.');
 for(const element of all){
  if(!svgTags.has(element.localName.toLowerCase()))throw new Error('SVG의 스크립트·외부 콘텐츠·스타일·애니메이션 요소는 지원하지 않습니다. PNG로 저장해 주세요.');
  for(const attr of element.attributes){const key=attr.name.toLowerCase(),value=attr.value;
   if(!svgAttrs.has(key)||key.startsWith('on'))throw new Error('SVG에 지원하지 않는 속성이 있습니다. PNG로 저장해 주세요.');
   if(key==='xmlns'||key==='xmlns:xlink'){if(value!==(key==='xmlns'?'http://www.w3.org/2000/svg':'http://www.w3.org/1999/xlink'))throw new Error('SVG 네임스페이스 오류');continue;}
   if(key==='href'||key==='xlink:href'){if(!/^#[\w.-]+$/.test(value))throw new Error('SVG 외부 이미지·링크는 사용할 수 없습니다.');}
   if(/[\\\x00-\x1f]|(?:https?:|data:|javascript:|file:|@import)/i.test(value)||/url\s*\(/i.test(value)&&!/^url\(\s*#[\w.-]+\s*\)$/.test(value))throw new Error('SVG 외부 참조는 사용할 수 없습니다.');
  }
 }
 return 'image/svg+xml';
}
function validateFont(ext,bytes){
 const bad=()=>{throw new Error('폰트 형식 또는 내부 크기 정보가 올바르지 않습니다. WOFF/WOFF2/TTF/OTF 원본 파일을 선택해 주세요.');};
 const magic=bytes.toString('ascii',0,4);if(bytes.length<12)return bad();
 if(ext==='.woff'||ext==='.woff2'){
  const woff=ext==='.woff',header=woff?44:48;
  if(bytes.length<header||magic!==(woff?'wOFF':'wOF2')||bytes.readUInt32BE(8)!==bytes.length||!bytes.readUInt16BE(12)||bytes.readUInt16BE(12)>512||bytes.readUInt16BE(14)!==0||bytes.readUInt32BE(16)<12||bytes.readUInt32BE(16)>64*1024*1024)return bad();
  if(woff){const count=bytes.readUInt16BE(12);if(header+count*20>bytes.length)return bad();for(let n=0;n<count;n++){const offset=header+n*20,start=bytes.readUInt32BE(offset+4),length=bytes.readUInt32BE(offset+8);if(start<header+count*20||start+length>bytes.length)return bad();}}
  else if(!bytes.readUInt32BE(20)||bytes.readUInt32BE(20)>bytes.length-header)return bad();
 }else{
  if(ext==='.otf'?magic!=='OTTO':bytes.readUInt32BE(0)!==0x10000&&magic!=='true')return bad();const count=bytes.readUInt16BE(4);if(!count||count>512||12+count*16>bytes.length)return bad();for(let n=0;n<count;n++){const offset=12+n*16,start=bytes.readUInt32BE(offset+8),length=bytes.readUInt32BE(offset+12);if(start<12+count*16||start+length>bytes.length)return bad();}
 }
 return types[ext];
}
export function validateAsset(name,bytes){assetName(name);if(!Buffer.isBuffer(bytes)||bytes.length>12*1024*1024)throw new Error('자산은 파일당 12MB 이하로 올려 주세요.');const ext=extname(name).toLowerCase();if(ext==='.svg')return validateSvg(bytes);if(['.woff','.woff2','.ttf','.otf'].includes(ext))return validateFont(ext,bytes);return validateImage(name,bytes);}
function root(store,id){return id===null?join(store.root,'_asset-library'):store.path(id,'assets');}
function metadata(store,id){return id===null?join(root(store,id),'library.json'):store.path(id,'meta.json');}
async function meta(store,id){if(id!==null)return store.meta(id);await mkdir(root(store,id),{recursive:true,mode:0o700});try{return JSON.parse(await readFile(metadata(store,id),'utf8'));}catch(e){if(e.code==='ENOENT')return {assetNames:{},uploadedFiles:[]};throw e;}}
function checkedPath(path){if(typeof path!=='string'||path.startsWith('/')||path.includes('\\')||path.split('/').some(p=>!p||p==='.'||p==='..')||/[\x00-\x1f]/.test(path))throw new Error('잘못된 파일 경로입니다.');return path;}
async function safeFile(store,id,path){checkedPath(path);const dir=resolve(root(store,id)),file=resolve(dir,path);if(!file.startsWith(dir+'/'))throw new Error('잘못된 파일 경로입니다.');if((await lstat(file)).isSymbolicLink()||await realpath(file)!==file)throw new Error('심볼릭 링크 파일은 사용할 수 없습니다.');return file;}
function lock(store,id,fn){return store.locked(id===null?'_asset-library':id,fn);}

async function listing(store,id){
 const m=await meta(store,id);
 const info=id===null?{files:await Promise.all((m.uploadedFiles||[]).map(async path=>({path,bytes:(await lstat(await safeFile(store,id,path))).size,canDelete:true,reason:'자료에 삽입하면 독립된 사본이 만들어집니다.'})))}:await inventory(store,id);
 const deck=id===null?null:await store.get(id);
 const document=deck?parseHTML(renderDeck(await readFile(store.path(id,'assets/index.html'),'utf8'),deck.state)).document:null;
 const slides=document?[...document.querySelectorAll('[data-sd-slide]')]:[];
 const files=await Promise.all(info.files.filter(f=>types[extname(f.path).toLowerCase()]).map(async f=>({...f,name:m.assetNames?.[f.path]||basename(f.path),type:types[extname(f.path).toLowerCase()],src:f.path,modifiedAt:(await lstat(await safeFile(store,id,f.path))).mtime.toISOString(),usage:slides.flatMap(s=>s.innerHTML.includes(f.path)?[{slide:s.getAttribute('data-sd-slide'),index:deck.state.order.indexOf(s.getAttribute('data-sd-slide'))}]:[]).filter(u=>u.index>=0)})));
 return {...info,files};
}
export function listAssets(store,id=null){return lock(store,id,()=>listing(store,id));}
export async function readAsset(store,id,path){return lock(store,id,async()=>{checkedPath(path);const m=await meta(store,id);if(!types[extname(path).toLowerCase()]||id===null&&!(m.uploadedFiles||[]).includes(path))throw new Error('이미지를 찾을 수 없습니다.');const bytes=await readFile(await safeFile(store,id,path));const type=validateAsset(basename(path),bytes);return {bytes,type,name:m.assetNames?.[path]||basename(path)};});}
export async function uploadAsset(store,id,{name,bytes,collision='rename'}){validateAsset(name,bytes);if(!['rename','skip'].includes(collision))throw new Error('이름 충돌 처리 방식을 확인해 주세요.');return lock(store,id,async()=>{const m=await meta(store,id),info=await listing(store,id);name=assetName(name);const names=new Set(info.files.map(f=>f.name.toLowerCase()));if(names.has(name.toLowerCase())){if(collision==='skip')return {skipped:true,name};const ext=extname(name),stem=name.slice(0,name.length-ext.length);let n=2;const candidate=()=>`${stem.slice(0,180-ext.length-String(n).length-3)} (${n})${ext}`;while(names.has(candidate().toLowerCase()))n++;name=candidate();}
 const used=id===null?info.files.reduce((n,f)=>n+f.bytes,0):info.assetBytes,count=id===null?info.files.length:(await inventory(store,id)).files.length;if(count>=300||used+bytes.length>64*1024*1024)throw new Error('보관함은 300개 파일, 64MB까지 저장할 수 있습니다.');const path='assets/'+randomUUID()+extname(name).toLowerCase();await mkdir(join(root(store,id),'assets'),{recursive:true,mode:0o700});if(await realpath(join(root(store,id),'assets'))!==resolve(root(store,id),'assets'))throw new Error('심볼릭 링크 폴더에는 업로드할 수 없습니다.');await writeFile(join(root(store,id),path),bytes,{flag:'wx',mode:0o600});m.uploadedFiles=[...(m.uploadedFiles||[]),path];m.assetNames={...m.assetNames,[path]:name};try{await store.atomic(metadata(store,id),m);}catch(e){await rm(join(root(store,id),path));throw e;}return {src:path,path,name};});}
export async function renameAsset(store,id,path,name){name=assetName(name);return lock(store,id,async()=>{const info=await listing(store,id),item=info.files.find(f=>f.path===checkedPath(path));if(!item)throw new Error('이미지를 찾을 수 없습니다.');if(info.files.some(f=>f.path!==path&&f.name.toLowerCase()===name.toLowerCase()))throw new Error('같은 이름이 있습니다. 다른 표시 이름을 입력해 주세요.');const m=await meta(store,id);m.assetNames={...m.assetNames,[path]:name};await store.atomic(metadata(store,id),m);return {...item,name};});}
export function deleteAsset(store,id,path){return lock(store,id,async()=>{const info=await listing(store,id),item=info.files.find(f=>f.path===checkedPath(path));if(!item)throw new Error('이미지를 찾을 수 없습니다.');if(!item.canDelete)throw new Error('원본 또는 저장 버전에서 사용하는 이미지는 삭제할 수 없습니다.');const file=await safeFile(store,id,path),m=await meta(store,id);m.uploadedFiles=(m.uploadedFiles||[]).filter(p=>p!==path);if(m.assetNames)delete m.assetNames[path];await store.atomic(metadata(store,id),m);await rm(file);return {ok:true};});}
export async function copyAsset(store,from,to,path,options={}){const file=await readAsset(store,from,path);return uploadAsset(store,to,{name:file.name.toLowerCase().endsWith(extname(path).toLowerCase())?file.name:file.name+extname(path),bytes:file.bytes,collision:options.collision||'rename'});}
