# open-slide reference application

Goal: apply useful open-slide ideas to the existing SDLAB editor while preserving its stored decks, revisions, note isolation and sharing policies.

Reference: open-slide/open-slide commit 1f18ab5970fa5e68219b8ff1811799d5018122cd, MIT, copyright 2026 Yiwei Ho. REA 6.5.0 inspected selected inert source; it did not execute open-slide. Evidence identities and source-selection limitations are in docs/open-slide-rea-evidence.json.

Design: keep SDLAB's existing editor and proposal system. Add private, slide/object-targeted AI modification requests, with a readable list, direct target navigation, completion/reopen, and a copyable prompt. A read-only MCP tool supplies requests to external AI; AI continues to submit proposals for human comparison and acceptance. Feedback is stored outside presentation state/assets, so it is absent from audience/share/export files and does not create content revisions. Missing/stale targets are shown explicitly. A separate export-only change settles finite CSS animations before image/PDF/PPTX capture, if a regression fixture confirms the gap.

Scope/ownership: server worker owns feedback persistence/routes/security tests; export worker owns capture settling and its regression; root owns UI, MCP tool/instructions, integration tests, docs, release. No React migration, remote logo catalogue, source-code comment injection, or arbitrary percentage progress.

Validation: request persistence and CAS, target validation, sharing/export privacy, real browser request→MCP read→proposal→selective apply→manual resolve, keyboard and notebook viewport, delayed animation capture, existing full regression and Windows/Linux MCP CI. Publish reviewed code and update only Slides with a consistent private data backup. Existing deployment authorization and operational constraints remain in effect.

User steering: editor interaction/visual quality and PowerPoint quality have priority; inspect overlapping features too. Expanded implementation: command search and overview reuse existing handlers/thumbnails; collapsible ribbon; all three built-in templates gain distinct editable layouts; image/editable PPTX retain validated web/internal links and resolve available font fallbacks. PDF links remain out of scope. Independent worker ownership: navigation UI/tests, templates/backend, export collectors/output/tests; root integrates feedback/MCP/docs/release.
