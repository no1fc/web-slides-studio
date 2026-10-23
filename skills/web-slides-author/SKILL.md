---
name: web-slides-author
description: Create or revise editable HTML slide decks for Web Slides Studio, including locally bundled Three.js decoration, importable ZIPs, and revision-safe edits through its MCP tools.
---

# Web Slides Author

Read [the runtime contract](references/runtime.md) before generating or changing a deck. Follow the user's topic, audience, duration, source material, and requested output. Ask only for missing facts that would change the result; label assumptions and unverified claims.

Use these three responsibilities as sequential passes. They are roles, not a requirement to launch separate agents.

1. **Author:** Define each slide's message and supporting evidence. Write concise, editable text and relevant speaker notes. Do not put private information in notes: published HTML and PPTX include them.
2. **Designer:** Implement the narrative in a 1920×1080 HTML deck. Keep words in DOM elements. Use Three.js only when it clarifies the subject or the user requests it; preserve readable static content without WebGL or motion. Package local assets and their required license notices.
3. **Reviewer:** Inspect every slide at presentation size, check overflow and missing assets, keyboard focus and navigation, reduced motion, and applicable export behavior. Reopen the imported result and test one text edit plus save/reload. Report checks actually performed and remaining limits.

For a new deck, produce `index.html`, local assets, and a ZIP. Deliver the actual files, not only code snippets or a plan. If the connected tools and user request authorize importing, import the ZIP and return the deck's editor link. Otherwise deliver the ZIP with import instructions.

For existing decks, use `slides_get_deck` and, when needed, `slides_get_slide_source` first. Preserve unrelated state and the observed revision. Update a single HTML/CSS fragment with `slides_update_slide`, or the full state with `slides_update_state` only when needed. A revision conflict requires a fresh read and reconciliation; never silently overwrite another edit.

Three.js scripts belong in the original imported HTML bundle. The slide-fragment editor and MCP fragment update accept validated HTML/CSS, not scripts or canvas. If changing that boundary is necessary, prepare a new bundle and explain that importing creates a separate deck.

Finish with the files or editor link, verification evidence, and material limitations. Sharing, deployment, and destructive operations need the corresponding user request; authoring alone does not authorize them.
