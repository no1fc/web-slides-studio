# Web Slides Studio runtime contract

## HTML bundle

- Use a complete HTML document with one `index.html` entrypoint. Put it at ZIP root, or inside a single containing folder with its assets.
- Use a `main#stage` sized 1920×1080 with `position:relative; transform-origin:0 0`. Put all sibling `section.slide` elements inside it. Use 1–80 slides, normally `position:absolute; inset:0; display:none`; display only `.slide.active`. Initially mark exactly one slide active.
- Keep text in `h1`–`h4`, `p`, `li`, or other simple DOM text elements. Canvas-rendered words are not editable text. Avoid transforms on text containers when normal layout suffices.
- The studio handles active slide and stage scale. Standalone navigation must not fight its bridge. If adding standalone controls, initialize them only when `#sd-config` is absent. Do not install global keyboard handlers that consume Tab, editing keys, or presenter keys. Keep controls out of slide content and use natural tab order, never positive `tabindex`.
- Hide `.notes` visually; their content is imported as speaker notes. New shares omit notes by default; HTML/PPTX exports offer an explicit include-notes option. Do not assume legacy publications have excluded notes.
- Bundle all images, CSS, fonts, and JS using relative paths. Do not include credentials, environment files, hidden files, symlinks, or development dependencies.
- ZIP ≤40 MiB, expanded contents ≤64 MiB, ≤300 files. Accepted extensions: `.html .css .js .png .jpg .jpeg .webp .gif .svg .ico .woff .woff2 .ttf .otf .json .mp4 .webm`. `.mjs`, `.gltf`, `.glb`, and `.bin` are not imported.

## Three.js and animation

Scripts run in imported HTML bundles. External CDN scripts, remote images/fonts, frames, workers, and network APIs are blocked. `connect-src 'none'` blocks fetch/XHR/WebSocket, including local JSON fetches. A `.json` asset being accepted does not make fetch available.

Bundle the Three.js library and its JS dependencies as local `.js` modules with relative imports, or a local browser bundle. Avoid bare module specifiers without a bundled resolution strategy. Prefer primitive geometries and procedural materials; a GLTFLoader pipeline is incompatible with the current file/network restrictions. Preserve the library license notice in the distributed bundle or HTML credits.

Decorative canvas should be behind content with `pointer-events:none` and `aria-hidden="true"`. `#bg` or `canvas[data-background]` participates in the studio's background toggle. Optional `data-scene` names describe scenes only if the bundle implements their rendering (for example a `window.setScene` hook); the editor does not generate scenes or offer a 3D model/camera editor.

Keep a static CSS/image fallback visible if WebGL fails. Honor `prefers-reduced-motion`, pause animation when hidden, and render a meaningful frame before export capture. Avoid time-dependent content that is blank until a long animation finishes. Check the studio preview and output, not just a standalone browser page. Static thumbnails do not execute the original scripts.

ES modules require HTTP serving for reliable use after download. In the extracted folder, `python3 -m http.server 8000 --bind 127.0.0.1` is one option; open `http://127.0.0.1:8000`.

## Fragment edits and outputs

The HTML/CSS editor and `slides_update_slide` take the **inside of one slide**, not a full document or `.slide` wrapper. Scripts, event handlers, canvas, iframe, SVG markup, CSS imports, external asset URLs, and reserved IDs/classes are rejected. Use supported HTML and local assets already present in the deck. For exact validation inspect the repository's `src/authoring.js` when available.

Replacing a slide fragment clears its source-object patches. Added objects, notes, and master connections remain; preserve those deliberately. HTML/CSS changes do not replace the original asset files.

HTML ZIP retains web behavior. PDF and appearance-preserving PPTX contain slide images. Editable PPTX converts supported DOM text, images, basic shapes, tables, and charts; complex CSS and Three.js remain raster backgrounds. Never promise editable native 3D or selectable PDF text. Link behavior is supported in presentation/share/HTML, not PDF/PPTX.

## Connected MCP tools

Discover available tools and their schemas before use; hosts may prefix names.

| Tool | Arguments | Use |
| --- | --- | --- |
| `slides_diagnose_connection` | `{}` | Report actual server/auth/tool/workspace checks, adapter version and report time without secrets |
| `slides_propose_slide` | `deckId`, `revision`, `slideId`, `html`, `css` | Stage a slide proposal for human review; does not save over current state |
| `slides_list_feedback` | `deckId`, optional `includeResolved` | Read private modification requests, their content revision and target/stale status; never automatically resolve |
| `slides_propose_state` | `deckId`, `revision`, `state`, optional `summary` | Stage a complete state for human review |
| `slides_list_decks` | `{}` | Find a deck |
| `slides_get_deck` | `deckId` | Read revision, state, slide/object IDs and editor link |
| `slides_create_deck` | optional `title` | Create a blank deck |
| `slides_get_slide_source` | `deckId`, `slideId` | Read an HTML/CSS fragment |
| `slides_update_slide` | `deckId`, `revision`, `slideId`, `html`, `css` | Replace one validated fragment |
| `slides_update_state` | `deckId`, `revision`, `state` | Save a complete state based on the read version |
| `slides_import_bundle` | `path` | Import a local ZIP as a new deck |

Use proposal tools by default and send the user to the editor to compare and apply selected changes. The two `slides_update_*` tools retain direct-save behavior for compatibility; use them only when the user explicitly requests skipping review. Never say a proposal is already applied.

Read IDs from tool responses; do not invent them. `revision` is the positive integer from the current deck. A `revision_conflict` error is not a successful write; reread and reconcile before retrying. Import requires a regular `.zip` inside the configured `SLIDES_STUDIO_WORKSPACE`, with no symlink or path escape. The service revalidates ZIP content.

Runtime configuration uses `SLIDES_STUDIO_URL`, preferably `SLIDES_STUDIO_PASSWORD_FILE` (or `SLIDES_STUDIO_PASSWORD`), and optional `SLIDES_STUDIO_WORKSPACE` for imports. The password belongs in the runtime environment or private file, never prompts, deck content, committed client config, or tool output. Remote endpoints require HTTPS; loopback HTTP supports local use. This adapter does not publish or delete decks.
