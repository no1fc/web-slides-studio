(() => {
  const fail = message => { throw new Error(message); };
  function directory(bytes, format) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--) {
      if(view.getUint32(i,true)===0x06054b50 && i+22+view.getUint16(i+20,true)===bytes.length){end=i;break;}
    }
    if(end<0)fail('압축 파일을 읽을 수 없습니다. 원본에서 ZIP 또는 PPTX로 다시 저장해 주세요.');
    const count=view.getUint16(end+10,true), offset=view.getUint32(end+16,true),size=view.getUint32(end+12,true);
    if(view.getUint16(end+4,true)||view.getUint16(end+6,true)||count===65535||offset+size>end)fail('분할 압축 또는 ZIP64는 지원하지 않습니다. 일반 ZIP으로 다시 압축해 주세요.');
    let p=offset,total=0;const files=[],names=new Set();
    for(let i=0;i<count;i++){
      if(p+46>end||view.getUint32(p,true)!==0x02014b50)fail('압축 목록이 손상되었습니다. 다시 압축해 주세요.');
      const length=view.getUint16(p+28,true), next=p+46+length+view.getUint16(p+30,true)+view.getUint16(p+32,true);
      if(next>end)fail('압축 목록이 손상되었습니다.');
      const name=new TextDecoder().decode(bytes.subarray(p+46,p+46+length));
      const path=name.endsWith('/')?name.slice(0,-1):name;
      if(!path||path.length>240||/[\\:\x00-\x1f]/.test(path)||path.startsWith('/')||path.split('/').some(x=>!x||x==='..'||(format==='pptx'?x==='.' :x.startsWith('.'))))fail('안전하지 않은 파일 경로가 있습니다. 발표 폴더 안의 일반 파일만 다시 압축해 주세요.');
      if(names.has(name.normalize('NFC')))fail('같은 경로의 파일이 중복되어 있습니다. 이름을 정리하고 다시 압축해 주세요.');
      names.add(name.normalize('NFC'));
      if(((view.getUint32(p+38,true)>>>16)&0o170000)===0o120000)fail('바로가기·심볼릭 링크는 사용할 수 없습니다. 실제 파일을 복사해 주세요.');
      if(view.getUint16(p+8,true)&1)fail('암호화된 압축은 지원하지 않습니다. 압축 암호를 해제해 주세요.');
      if(!name.endsWith('/')){total+=view.getUint32(p+24,true);files.push(name);}
      if(total>64*1024*1024)fail('압축을 풀면 64 MiB를 넘습니다. 큰 이미지·동영상을 줄여 주세요.');
      if(files.length>(format==='pptx'?2000:300))fail(`파일 수가 ${format==='pptx'?2000:300}개를 넘습니다. 사용하지 않는 파일을 제외해 주세요.`);
      p=next;
    }
    if(p!==offset+size)fail('압축 목록 크기가 올바르지 않습니다. 다시 압축해 주세요.');
    return {files,total};
  }
  async function text(entry, limit=4*1024*1024) {
    return new Promise((resolve,reject)=>{
      const chunks=[];let total=0,failed=false;const stream=entry.internalStream('uint8array');
      stream.on('data',chunk=>{if(failed)return;total+=chunk.length;if(total>limit){failed=true;stream.pause();reject(new Error('시작 HTML이 너무 큽니다. 이미지·동영상을 별도 파일로 분리해 주세요.'));return;}chunks.push(chunk);});
      stream.on('error',reject);stream.on('end',()=>{if(failed)return;const bytes=new Uint8Array(total);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}resolve(new TextDecoder().decode(bytes));});stream.resume();
    });
  }
  globalThis.SDUploadCheck={directory,text};
})();
