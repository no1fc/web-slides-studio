# Stage 4 Implementation Plan

> Agentic workers: delegate the three independent ownership areas below, then request a fresh-context review. Coordinator owns parent UI, integration, documentation and publication.

Spec: ../specs/2026-10-21-stage4-objects-design.md

- [x] Shared model/server: object-model.js, deck.js, store.js; unit/state tests. Validation, image geometry/rendering, shapes and group transforms. HTML children are excluded, so authoring.js needs no recursive changes.
- [x] Bridge: bridge.js, text-editor.js, server.js; object-browser tests. Selection, patching, native snapshot/group commands, scale constraints, collect/hide export contract.
- [x] Export: export.js, object-export.js and text-export.js; object-export tests. Original image sources/crop and editable geometry, flattened group children, HTML ZIP scripts, overlap-preserving fallback.
- [x] Parent UI/integration: app.js, index.html, style.css; object-ui tests. Validated single-command replacement, controls and history/lock/context boundaries.
- [x] Targeted regressions, 1600px/1280px visual inspection, fresh-context review and final npm test: 181/181 pass, no failures/skips, concurrency=2, 2026-10-21.
- [x] Public guides and STAGE4_LINUX_DEPLOYMENT.md, including rollback and stages 5–7.

Publication procedure: commit the exact tested tree, publish main without force using the expected remote SHA, then verify remote commit and tree. Linux deployment remains with the user.

Review fixes: preserve earlier rectangle text and inherited font sizes, reject missing effective image sources, use renderer-consistent z defaults, preserve child order on ungroup, and protect raster/native overlap including overflowing text. Re-review found no remaining reported issues.
