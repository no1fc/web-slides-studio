import { parseHTML } from "linkedom";

export function withoutNotesHtml(html, deck) {
  const { document } = parseHTML(html);
  for (const node of document.querySelectorAll('.notes,[data-speaker-notes],script#sd-notes')) node.remove();
  if(deck) for(const script of document.querySelectorAll("script")) script.textContent=redactNoteText(script.textContent,deck);
  return document.toString();
}
export function withoutNotesState(state) {
  const copy = structuredClone(state);
  copy.notes = {};
  for (const section of [copy.slideCode, copy.masters]) for (const entry of Object.values(section || {})) {
    if (typeof entry.html === 'string') entry.html = withoutNotesHtml(entry.html);
  }
  const cleanObject = object => {
    if(typeof object.html === 'string') object.html=withoutNotesHtml(object.html);
    for(const child of object.group?.children || []) cleanObject(child);
  };
  for(const object of copy.added || []) cleanObject(object);
  return copy;
}
export function withoutNotesDeck(deck) {
  return { ...deck, state: withoutNotesState(deck.state), sourceNotes: {}, slides: deck.slides.map(({notes, ...slide}) => slide) };
}
// Keep a mapping to the original bytes so redaction preserves quote/escape syntax.
function redactLiteral(literal, values) {
  const encoded=literal.includes('\\');
  let decoded=encoded?'':literal.slice(1,-1),spans=[];
  for(let i=1;encoded&&i<literal.length-1;) {
    const start=i;let value=literal[i++];
    if(value==='\\' && i<literal.length-1) {
      const next=literal[i++];
      const unicode=next==='u' ? /^(?:\{([0-9a-f]{1,6})\}|([0-9a-f]{4}))/i.exec(literal.slice(i)) : null;
      const hex=next==='x' ? /^[0-9a-f]{2}/i.exec(literal.slice(i)) : null;
      if(unicode) { const point=parseInt(unicode[1]||unicode[2],16);value=point<=0x10ffff?String.fromCodePoint(point):'';i+=unicode[0].length; }
      else if(hex) {value=String.fromCharCode(parseInt(hex[0],16));i+=hex[0].length;}
      else value=({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','\n':'','\r':''})[next] ?? next;
    }
    decoded+=value;for(let n=0;n<value.length;n++)spans.push([start,i]);
  }
  const ranges=[];
  for(const value of values) for(let at=decoded.indexOf(value);at>=0;at=decoded.indexOf(value,at+value.length)) {
    const range=encoded?[spans[at][0],spans[at+value.length-1][1]]:[at+1,at+value.length+1],last=ranges.at(-1);
    if(last && range[0]>=last[0] && range[0]<=last[1]) last[1]=Math.max(last[1],range[1]);
    else ranges.push(range);
  }
  if(!ranges.length)return literal;
  ranges.sort((a,b)=>a[0]-b[0]);
  const merged=[];
  for(const range of ranges) { const last=merged.at(-1);if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else merged.push(range); }
  const output=[];let cursor=0;
  for(const [start,end] of merged) {output.push(literal.slice(cursor,start));cursor=end;}
  output.push(literal.slice(cursor));return output.join('');
}
export function redactNoteText(text, deck) {
  const values=[...new Set([...Object.values(deck.state.notes || {}), ...Object.values(deck.sourceNotes || {}), ...deck.slides.map(s => s.notes || '')].filter(Boolean))];
  if(!values.length)return text;
  let cursor=0;
  const redactChunk=chunk=>redactLiteral('`'+chunk+'`',values).slice(1,-1);
  function template(depth) {
    if(depth>100)throw new Error('중첩된 스크립트가 너무 복잡해 노트를 안전하게 제외할 수 없습니다.');
    const output=['`'];let start=++cursor;
    while(cursor<text.length) {
      if(text[cursor]==='\\'){cursor+=2;continue;}
      if(text[cursor]==='`') {output.push(redactChunk(text.slice(start,cursor)),'`');cursor++;return output.join('');}
      if(text[cursor]==='$'&&text[cursor+1]==='{') {
        output.push(redactChunk(text.slice(start,cursor)),'${');cursor+=2;output.push(code(true,depth+1));start=cursor;continue;
      }
      cursor++;
    }
    output.push(redactChunk(text.slice(start)));return output.join('');
  }
  function code(interpolation=false,depth=0) {
    const output=[];let start=cursor,braces=0,regexAllowed=true;
    while(cursor<text.length) {
      const char=text[cursor],next=text[cursor+1];
      if(char==='"'||char==="'") {
        output.push(text.slice(start,cursor));const from=cursor++;
        while(cursor<text.length) {if(text[cursor]==='\\'){cursor+=2;continue;}if(text[cursor++]===char)break;}
        output.push(redactLiteral(text.slice(from,cursor),values));start=cursor;regexAllowed=false;continue;
      }
      if(char==='`') {output.push(text.slice(start,cursor),template(depth));start=cursor;regexAllowed=false;continue;}
      if(char==='/'&&(next==='/'||next==='*')) {
        output.push(text.slice(start,cursor));const from=cursor;cursor+=2;
        if(next==='/')while(cursor<text.length&&!/[\r\n]/.test(text[cursor]))cursor++;
        else {const end=text.indexOf('*/',cursor);cursor=end<0?text.length:end+2;}
        output.push(redactChunk(text.slice(from,cursor)));start=cursor;continue;
      }
      if(char==='/') {
        let end=cursor+1,inClass=false,closed=false;
        while(end<text.length) {const c=text[end++];if(c==='\\'){end++;continue;}if(c==='[')inClass=true;else if(c===']')inClass=false;else if(c==='/'&&!inClass){closed=true;break;}else if(c==='\n'||c==='\r')break;}
        const candidate=text.slice(cursor,end);
        // Ambiguous slash contexts are checked too; rewriting regex syntax could change the deck.
        if(closed&&redactChunk(candidate)!==candidate)throw new Error('스크립트 정규식에 발표자 노트가 포함되어 있습니다. 해당 내용을 제거한 뒤 노트를 제외해 공유해 주세요.');
        if(regexAllowed) {
          cursor=end;while(cursor<text.length&&/[a-z]/i.test(text[cursor]))cursor++;
          regexAllowed=false;continue;
        }
      }
      if(char==='{'){braces++;regexAllowed=true;cursor++;continue;}
      if(char==='}') {cursor++;if(interpolation&&braces===0){output.push(text.slice(start,cursor));return output.join('');}braces--;regexAllowed=false;continue;}
      if(/[a-z_$]/i.test(char)) {
        const from=cursor++;while(cursor<text.length&&/[\w$]/.test(text[cursor]))cursor++;
        regexAllowed=/^(?:return|throw|yield|case|delete|typeof|void|new|in|of|await)$/.test(text.slice(from,cursor));continue;
      }
      if(!/\s/.test(char))regexAllowed=/[=(:,;!?&|+*%~^<>\[]/.test(char);
      cursor++;
    }
    output.push(text.slice(start,cursor));return output.join('');
  }
  return code();
}
