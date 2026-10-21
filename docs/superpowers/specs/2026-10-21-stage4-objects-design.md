# Stage 4 Images, Shapes and Groups

사용자가 승인한 4단계 로드맵을 구현한다. 기존 schemaVersion 1, 저장 충돌 처리, Undo/Redo, HTML/CSS/JSON 편집을 유지한다. main 게시까지 승인되었으며 실제 서버 배포는 사용자가 수행한다.

## Shared object contract

`public/object-model.js`는 브라우저와 Node에서 사용하는 `globalThis.SDObjects`를 정의한다. 신규 의존성은 없다.

- `image: {mode: "fill"|"fit"|"stretch", crop: {left,top,right,bottom}}`: crop은 원본의 0~1 비율이며 대향 합은 0.99 이하이다. 기본 mode=stretch, crop=0으로 이전 이미지 외형을 유지한다. src 원본은 보존한다. 표준 overflow/position을 사용하는 프레임 안의 IMG로 표시하고, naturalWidth/Height를 읽어 배치한다. 실험적 object-view-box에 의존하지 않는다.
- `shape: {type:"rect"|"ellipse"|"line"|"arrow", fill:"#RRGGBB"|"none", stroke:"#RRGGBB", strokeWidth:0..40, dash:"solid"|"dash"|"dot"}`. 이전 kind=shape/fill은 사각형으로 호환한다. 생성한 SVG만 사용한다.
- `kind:"group", group:{width,height,children:[snapshot...]}`. width/height는 그룹 내부 좌표계 크기이다. children은 id/slide가 없는 text/image/shape/group 스냅샷이며 x/y/w/h/rotate를 가진다. 깊이 4, 전체 재귀 개체 수 500 및 기존 2MB 제한을 적용한다. HTML 스냅샷은 그룹 대상에서 제외한다.
- 그룹의 w/h는 내부 좌표계에 대해 균일 비율로만 조절한다. 그룹 해제는 중심 기준 회전, 균일 배율, 이동을 자식 위치와 크기에 반영한다. 텍스트의 글자 크기/문단 간격/여백 및 도형 테두리도 같은 비율로 반영한다. 범위를 벗어나면 전체 명령을 거부한다.
- native text의 선택적 `textMetricsScale`(0.01~100)은 그룹 해제 시 글머리표와 들여쓰기의 고정 간격을 같은 배율로 유지한다. 글자 크기·문단 간격은 실제 값으로 확대하고 이 값은 목록 간격에만 적용한다.
- 그룹 자식에는 data-sd-id를 만들지 않는다. 최상위 그룹만 선택/잠금/레이어/Undo 단위이다. 그룹 내부 편집은 해제 후 수행한다.

## Shared API

- `normalizeImage(value)`, `normalizeShape(value, legacyFill)`, `normalizeGroup(value)` reject unknown keys and invalid values.
- `imageLayout(width,height,naturalWidth,naturalHeight,image)` returns `{x,y,w,h,crop:{left,top,right,bottom},frame:{x,y,w,h}}`: x/y/w/h are full source image placement in frame; crop is effective source crop after Fill; frame is visible image bounds (Fit may letterbox).
- `applyVisual(element, object)` updates generated image/shape/group content without changing the element identity. Element must be a DIV for canonical images/shapes/groups. It stamps `data-sd-kind` and serialized data attributes. Groups render recursively via `createElement(document, object)`.
- `createElement(document, object)` returns a fully positioned element for text/image/shape/group (no id/slide). Text uses SDText. Group render uses an inner frame transformed with scale(w/group.width), transform-origin:0 0.
- `refresh(root)` lays out images on load/resize and fits rich text if SDTextEditor is available; used by bridge bootstrap and after relevant patches.
- `ungroup(object)` returns transformed child snapshots without id/slide; `groupObjects(snapshots)` returns one group in slide coordinates. Helpers preserve explicit ordering, source, text and crop and reject unsupported geometry.

## Commands and UI

Parent toolbar adds Group / Ungroup, image mode and crop percentage fields plus Reset Crop, shape type/fill/stroke/width/dash controls. Shape insert offers the four types. Width/height aspect checkbox is enforced for groups.

Bridge `select` payload adds `kind`, `image`, `shape`, `groupable` and `group` metadata. Source image original can be duplicated into an independent native image; arbitrary HTML remains a snapshot. Group supports unlocked visible native added objects (text/image/shape/group) sharing a parent, not imported HTML containers.

Bridge sends `object-structure` with `{operation:"group"|"ungroup", slide, removeIds, objects}`. Parent validates active slide/session, exact selection and native added-object IDs, validates the complete candidate via API, then removes sources and their patches and adds results in one history command. Reject stale/busy commands. Copy/duplicate/paste preserve native kinds.

## Rendering and export

Server includes object-model.js before bridge; HTML ZIP includes the same script. Image frames retain original local src; local path validation and store file-existence checks recurse through groups. Native image and generated shape export uses original source bytes, PPTX crop and native shape geometry. Groups may flatten to editable children with correct transforms; reconstruction as a PPTX group and full arbitrary CSS fidelity belong to compatibility stage 6. Unsupported visuals stay in the background screenshot rather than silently disappearing. Original HTML handling remains compatible.

## Verification and release

Test malformed crop/shape/group JSON, recursion and local paths; group/ungroup at rotation/scale; image layout; rendering/HTML ZIP; crop preservation and native image/shape PPTX XML; browser controls, reload/history/lock/clipboard/slide duplication and original HTML boundaries. Run full suite with concurrency=2 and independent review. Document Linux deployment/rollback and remaining stages 5, 6, 7. Exclude local POWERPOINT_EDITING_ROADMAP.md from publication.
