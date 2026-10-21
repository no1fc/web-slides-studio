# 3단계: 실용적인 텍스트 편집

승인된 로드맵의 3단계를 기존 plain JavaScript/Node 편집기에 구현하고 테스트 후 GitHub main에 올린다. 실제 Linux 재배포는 사용자가 수행한다.

## 사용자 동작

- 텍스트 개체 전체 또는 더블클릭 후 선택한 문자 범위의 글꼴·크기·색·굵게·기울임·밑줄을 바꾼다. 선택 범위가 없는 개체 선택은 전체 서식, 텍스트 입력 중 범위는 부분 서식이다.
- 문단은 좌/가운데/우/양쪽 정렬, 줄간격, 문단 뒤 간격, 0~8단계 들여쓰기, 글머리표·번호를 지원한다. 선택한 문단에 적용하고 전체 개체 선택은 모든 문단에 적용한다.
- 텍스트 상자의 세로 정렬(위/가운데/아래), 넘침 표시/자르기, 자동 맞춤(없음/상자 안으로 글자 축소)을 지원한다. 자동 맞춤은 저장 글자 크기를 파괴하지 않고 표시 크기만 줄인다. 최소 표시 크기는 6px이며 맞지 않으면 넘침을 안내한다.
- 일반 입력·한글 조합과 문자 선택을 보존한다. 조합 중 명령은 확정 후 실행하고, 서식 한 번은 Undo 한 번이다. 외부 붙여넣기는 평문으로 받아 실행 가능한 HTML을 유입하지 않는다.
- 저장·재열기·슬라이드 복제·개체 복제·버전 복원·HTML/PDF 출력에 문단과 문자 서식을 보존한다. 편집형 PPTX에는 지원되는 run/문단·목록·글꼴·서식·줄간격을 기록한다. 실제 PowerPoint 외형 동등성은 별도 검증 범위이다.

## 모델과 구현 결정

schemaVersion 1을 하위 호환 확장한다. 기존 plain `text`는 계속 읽는다. 새 patch/added 필드:

```js
richText: { paragraphs: [{
  runs: [{ text, fontFamily?, fontSize?, color?, bold?, italic?, underline? }],
  align?, lineHeight?, spaceAfter?, indent?, list?
}] }
textBox: { vertical?: 'top'|'middle'|'bottom', overflow?: 'visible'|'clip', autoFit?: 'none'|'shrink' }
```

문자 글꼴 이름은 100자 이하 안전한 이름, 크기 6~400, 색 #RRGGBB, bool 서식. 문단 align은 left/center/right/justify, lineHeight 0.5~4, spaceAfter 0~200px, indent 정수0~8, list none/bullet/number. 최대 500문단·5000 run·100000문자, 기존 전체 상태 2MB 제한 유지. unknown/inherited key 및 임의 HTML을 거절한다. text와 richText를 함께 보내면 richText 내용이 우선하며 UI 평문 교체는 새 richText를 명시적으로 생성한다.

원본 HTML의 텍스트만 가진 편집 개체를 처음 서식 변경하거나 입력을 확정할 때 computed style을 구조화한다. 이미지·테이블·다른 편집 ID를 포함한 복합 컨테이너는 텍스트 도구를 비활성화한다. 일부 HTML의 장식·고급 문단 CSS를 완전히 재현하는 변환은 목표가 아니다. 변환 시 텍스트·기본 문자/문단 서식을 보존한다.

공유 모델 `public/text-model.js`는 classic script IIFE로 `globalThis.SDText`를 제공하며 Node에서도 import해 같은 검증·렌더링 함수를 사용한다. 문단과 run은 textContent 기반 DOM으로 렌더링하고 script·style HTML 입력을 받지 않는다. 브라우저 전용 DOM 읽기·선택 범위·자동 맞춤은 `public/text-editor.js`에 둔다.

기존 2단계 동작, origin/session 검사, 잠금, IME 확정 handshake, 저장 revision 충돌 처리를 유지한다. 새 프레임 스크립트는 콘텐츠 origin 및 HTML ZIP의 오프라인 viewer에도 포함한다. 새 의존성을 추가하지 않는다.

## 인터페이스

- SDText: normalizeRichText(value), normalizeTextBox(value), plainText(rich), formatRichText(rich, rangeOrNull, scope, changes), renderRichText(element,rich,textBox). scope=character|paragraph. range는 전체 텍스트 UTF-16 start/end offset(문단 사이 개행 1개).
- 정규화 DOM: `[data-sd-text-content]` 아래 `[data-sd-paragraph]`의 `[data-sd-run]`, 목록 장식 `[data-sd-marker]`. marker는 내용 offset에서 제외한다.
- select.elements의 각 info: textEditable, textEditing, textStyle(문자·문단 현재 값), textBox, textRange({start,end}|null), textOverflowing. 기존 info 필드는 유지한다.
- 부모→bridge: `text-format {id, requestId, scope:'character'|'paragraph'|'box', changes}`; `text-replace {id,requestId,text}`. 부모는 commit-edit를 기다린 후 보내며 scope가 character/paragraph이면 bridge가 보관한 range를 사용한다. 대상 ID/slide/session/잠금을 다시 확인한다. `text-command-result {requestId,error?}`로 무변경을 포함한 처리를 확인하며, 처리 중에 이전 저장 완료 표시를 노출하지 않는다.
- bridge→parent 변경은 기존 change {id,patch:{richText,textBox?}} 계약. 한 명령 한 history. collect()의 text 개체는 richText와 textBox, 실제 표시 fontScale, padding 정보도 제공한다.

## 검증

허용/거절 스키마, escape, legacy, 부분 run 분할·병합 및 문단 경계, 한글/emoji, 복제·버전·HTML 출력. 실제 Chrome에서 toolbar 포커스, 부분 서식 후 입력, IME 조합 중 명령·저장, 취소/Undo, 원본서식 보존, 잠금/복합개체 보호, 자동축소·세로정렬. PPTX XML에서 run 속성·문단·목록·줄간격 보존. 기존 전체 회귀와 별도 코드 검토 후 원격 main 트리를 검증한다.
