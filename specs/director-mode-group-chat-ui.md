# Director Mode Group Chat UI

Implement inline quick settings, a full Director settings modal, and an Inspector tab for group chat Director mode without changing core generation or server persistence behavior.

---

## TASK-01: Extend Director config typing and defaults
Priority: P0
Files: public/global.d.ts (modify), public/scripts/group-chats.js (modify)
Depends on: none
Acceptance: - `GroupDirectorConfig` includes optional `queueMode`, `queueMaxSize`, and `manualQueue`.
- `ensureDirectorConfig()` preserves existing values and defaults missing queue fields.
- `queueMaxSize` is clamped to `1-50`.
- Existing groups load without migration or `undefined` Director queue values.
Add backward-compatible queue configuration under `group.director`.
---

## TASK-02: Add inline Director quick settings UI
Priority: P1
Files: public/index.html (modify)
Depends on: none
Acceptance: - Existing Director enabled/profile/journal controls remain intact.
- `rm_group_director_quick_settings` block exists inside the Director settings area.
- Quick controls exist for message depth, include user messages, queue max, and Configure Director.
- Quick settings CSS supports wrapping and mobile full-width inputs/buttons.
Add common Director settings directly in the group settings panel.
---

## TASK-03: Create Director settings modal shell
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-01
Acceptance: - `openDirectorSettingsModal(group)` exists near the journal modal implementation.
- Modal uses existing `Popup` pattern with large layout and Close button.
- Tabs exist for Connection, Context, Queue, Prompts, and Inspector.
- Tab buttons switch visible panels correctly.
- Modal performs a final `editGroup()` save on close.
Create the shared modal container that later tasks populate.
---

## TASK-04: Bind inline quick settings in `loadDirectorSettings()`
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-01, TASK-02, TASK-03
Acceptance: - `loadDirectorSettings()` calls `ensureDirectorConfig(group)`.
- Quick settings reflect selected group Director values.
- Quick settings are visible only when Director is enabled.
- Inputs update `group.director` and save through debounced `editGroup()`.
- Event handlers use namespaced `.off().on()` bindings.
- Configure Director button opens the settings modal.
Wire the inline controls to persisted Director config.
---

## TASK-05: Implement Connection and Context modal tabs
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-03, TASK-04
Acceptance: - Connection tab includes Director enabled toggle and connection profile selector.
- Invalid or missing profile warning is visible using existing validation behavior.
- Profile changes sync between modal and inline controls.
- Context tab includes message depth, include user messages, existing context settings, and journal shortcut.
- Shared settings stay synchronized with quick settings and persist via debounced save.
Expose existing Director connection/context configuration in the modal.
---

## TASK-06: Implement Queue modal tab
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-01, TASK-03
Acceptance: - Queue tab includes Auto/Manual mode selector.
- Queue max size input clamps to `1-50`.
- Current queue display is rendered.
- Manual queue editor lists current group members.
- Reset, clear, move up, and move down controls update `group.director.manualQueue`.
- Deleted members are filtered from `manualQueue`.
- No speaker-selection or generation algorithm is changed.
Add UI for configuring and inspecting Director queue settings.
---

## TASK-07: Implement Prompts tab and preserve journal compatibility
Priority: P2
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-03
Acceptance: - Prompts tab exposes only prompt/settings fields already read from `group.director`.
- Prompt and journal content are handled as text values, not raw HTML.
- Existing `openDirectorJournalModal()` remains available and unchanged in behavior.
- Existing journal button and new modal controls write to the same `group.director.journal` field.
- Journal/prompt edits persist through debounced save and modal close save.
Keep existing journal behavior while improving discoverability.
---

## TASK-08: Implement Inspector tab
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-03, TASK-06, TASK-07
Acceptance: - Inspector shows enabled status, selected profile, last run timestamp if available, last error/warning, current queue, and decision history.
- Decision history is read from existing Director runtime/decision state.
- Member table shows character name, muted state, Director-muted/manual mute/not muted ownership, and last selected/skipped reason if available.
- Refresh Inspector button re-renders current runtime state.
- Inspector never clears manual mutes.
- Any editable mute action only clears Director-owned mutes.
- Journal editor in Inspector syncs with `group.director.journal`.
Expose runtime Director state safely without changing generation behavior.
---

## TASK-09: Add modal and Inspector responsive styling
Priority: P2
Files: public/index.html (modify)
Depends on: TASK-03, TASK-08
Acceptance: - Styles exist for `.director-settings-modal`, `.director-tabs`, `.director-tab`, `.director-tab-panel`, `.director-inspector-table`, and `.director-queue-list`.
- Modal layout is usable on desktop.
- At `max-width: 600px`, tabs scroll horizontally.
- Modal controls stack vertically on mobile.
- Inspector table scrolls horizontally instead of overflowing the viewport.
Make Director settings usable on desktop and mobile.
---

## TASK-10: Harden validation, sanitization, and persistence
Priority: P1
Files: public/scripts/group-chats.js (modify), public/index.html (modify), public/global.d.ts (modify)
Depends on: TASK-04, TASK-05, TASK-06, TASK-07, TASK-08, TASK-09
Acceptance: - Repeated UI loading does not create duplicate event handlers.
- All dynamic user-visible HTML is sanitized or rendered through DOM/text APIs.
- Debounced saves do not lose final modal input on close.
- Existing groups created before this change show valid defaults.
- Invalid profile warnings are visible in the modal.
- Manual mutes are never overridden by Inspector actions.
- `npm test` passes.
- Frontend lint/check script passes if available.
Perform final integration hardening and verification.
