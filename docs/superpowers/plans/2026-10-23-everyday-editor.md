# Everyday presentation editor implementation

User explicitly requested implementation, regression verification, GitHub publication and deployment of all nine areas. Extend the existing vanilla JS / Node editor, revision store and MCP installer; preserve source assets, IDs, history and links. No replacement framework or server install on external AI clients.

## Work and ownership
- Server: share expiry/password/note stripping; staged AI proposals and selective revision-safe apply; templates/assets/brand persistence; revision metadata and connection reports. Existing validation and isolation remain mandatory.
- Presenter: isolated audience rendering, presenter controls and synchronization, preflight DOM evidence and keyboard exit.
- AI integration: installer instructions/UI and actual MCP connection reports/proposal tools; Windows/Linux CI regression.
- Main: ribbon/continuous properties, multi-upload checks/retry, comparison/template/share/history UI, integration tests, documentation, release.

## Verification gates
Existing regression suite plus targeted tests for proposal preview/apply/conflict/cancel/restore, actual share responses and ZIP/PPTX note exclusion, password/expiry/revoke, independent template assets, batch partial retry, presenter sync and focus, laptop viewport. Run authenticated temporary fixtures, read existing production decks without modifying them. Push verified commits, inspect Windows/Linux Actions, build public checkout and update only studio service with rollback image and preserved data.

## Progress
- Baseline clean main, existing source and private deployment runbook inspected. Existing site work is unrelated and preserved.
- Nine requested areas implemented on the existing architecture; public help, authoring instructions and compatibility/deployment notes updated.
- Full regression passed 310/310; MCP passed 10/10. Independent review found selection, comparison navigation and in-flight edit preservation defects; fixed with regression cases. Final note sanitization fixes passed 11 targeted tests, including nested templates, escaped text, regex fail-closed behavior and linear repeated-match handling. Final full rerun is in progress.
- Laptop Chromium workflow and two-window presenter tests pass. The active production document passed edit/save/reload/restore on a private temporary copy; all 224 original file hashes unchanged (6 trashed decks excluded from editing). Windows/Linux Actions and deployment remain release gates.
