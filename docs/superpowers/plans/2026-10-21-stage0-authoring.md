# Stage 0 and authoring implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Save/geometry/selection fixes plus revisioned HTML/CSS/JSON and reusable master/template editing.
**Architecture:** Retain original HTML + state overlays; extend versioned state and render code/master layers inside existing content isolation.
**Tech Stack:** Node.js, vanilla browser JS, linkedom, Playwright (existing dependencies).
**Spec:** docs/superpowers/specs/2026-10-21-stage0-authoring-design.md

## Global Constraints
No production access or deployment. Preserve all old revisions, optimistic concurrency, separate origins, CSP and asset protection. No new runtime dependencies. No whole-editor rewrite.

## Review Focus
- Legacy state cannot lose unknown data silently; future versions rejected.
- Added x/y with partial patch must retain untouched axis live and after reopen.
- In-flight save must not overwrite newer edits; failed save retains draft.
- Code and masters cannot execute in manager origin or forge studio reserved markup.
- Copy/restore/export preserve code, master references and stable editable IDs.

### Task 1: State and authoring backend
Files: src/deck.js, src/authoring.js (new), src/store.js, src/server.js; test/authoring.test.js (new).
Interfaces: schemaVersion=1, slideCode, masters, slideMasters as spec; GET authoring and POST validate contracts as spec.
- [x] Add failing legacy/unknown/schema/partial-axis and authoring save/restore/render tests.
- [x] Run focused tests and record expected failures.
- [x] Implement validation, normalization, rendering and authenticated endpoints without rewriting asset source.
- [x] Run focused tests; check original versions remain immutable.

### Task 2: Bridge geometry and selection
Files: public/bridge.js; test/editor-foundation.test.js (new).
Interfaces: existing select/change messages; select element:null added. Changes remain one message per committed gesture.
- [x] Add browser failing tests for added initial coordinates, axis preservation, micro-drag/cancel, blank/slide deselection and IME/undo boundaries.
- [x] Run red, implement minimal fixes, run green.
- [x] Preserve collect/export and original HTML behavior.

### Task 3: UI authoring and save consistency
Files: public/app.js, public/index.html, public/style.css; test/authoring-ui.test.js (new).
Interfaces: Task1 API and state; Task2 null selection. HTML/CSS per-slide editor, JSON editor, master editor/apply, layout presets.
- [x] Add failing tests for UI authoring/save and delayed response follow-up edits.
- [x] Implement validation-before-apply, error-retaining drafts, undo integration and master/code-aware duplication.
- [x] Run focused green tests and complete shared contract fixes.

### Task 4: Review and delivery
Files: docs/STAGE0_LINUX_DEPLOYMENT.md, docs/USER_GUIDE.md; local handoff patch/zip.
- [x] Run full npm test with actual Chrome.
- [x] Fresh reviewer inspects whole diff; resolve important issues and rerun affected tests.
- [x] Document schema migration/rollback caveat, baseline commit, exact changed files, Linux install/test/staging and rollback steps.
- [x] Package git diff including new source/test files for Linux transfer; verify patch apply against original commit.
