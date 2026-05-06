# Director Group Reply Strategy and Inspector

Implement Director as group activation strategy value `4`, migrate legacy checkbox behavior, and add per-group Director settings/inspection modal.

---

## TASK-01: Add Director activation strategy enum value
Priority: P0
Files: public/scripts/group-chats.js (modify)
Depends on: none
Acceptance: - `group_activation_strategy.DIRECTOR` exists with value `4`
- Existing strategy values `0` through `3` are unchanged
- Existing export behavior is preserved if the enum is exported

## TASK-02: Update group strategy controls UI
Priority: P0
Files: public/index.html (modify)
Depends on: TASK-01
Acceptance: - `#rm_group_activation_strategy` includes `<option value="4">Director</option>`
- Director option uses `data-i18n` consistently if neighboring options do
- Director inspector button exists near the reply strategy dropdown
- `#rm_group_director_enabled` checkbox block is removed
- Old inline Director-only settings tied to the checkbox are removed

## TASK-03: Add Director defaults and normalization helpers
Priority: P0
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-01
Acceptance: - `DEFAULT_DIRECTOR_SETTINGS` defines lookback depth `10`, count user messages `true`, and default prompt placement
- `getDirectorData(group)` initializes `group.director.settings`, `stateHistory`, `decisionHistory`, and `lastDirections`
- Invalid lookback depth falls back to `10`; `0` is preserved
- Invalid placement type falls back to `relative`
- Invalid role falls back to `system`
- Invalid depth/order values are normalized safely

## TASK-04: Migrate legacy Director group data
Priority: P0
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-03
Acceptance: - `loadDirectorSettings(group)` migrates `director_enabled === true` to `activation_strategy = group_activation_strategy.DIRECTOR`
- Legacy `director_enabled` no longer drives active UI behavior
- Existing legacy Director settings are moved into `group.director.settings` when present
- Migration runs before the strategy dropdown is populated
- Groups with legacy Director disabled keep their existing activation strategy

## TASK-05: Support Director strategy persistence
Priority: P0
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-02, TASK-04
Acceptance: - Selecting Director in `#rm_group_activation_strategy` saves strategy value `4`
- Reloading a group with strategy value `4` selects Director in the dropdown
- Existing strategy change handlers accept `DIRECTOR` without clamping or falling back
- Natural, List, Manual, and Pooled persistence remains unchanged

## TASK-06: Remove obsolete Director checkbox code paths
Priority: P0
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-04
Acceptance: - No active code references `#rm_group_director_enabled`
- No event binding reads or writes the removed checkbox
- Director enablement is controlled only by `group.activation_strategy`
- Removed checkbox state cannot cause Director to run with another strategy

## TASK-07: Move Director execution into strategy switch
Priority: P0
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-03, TASK-05, TASK-06
Acceptance: - `generateGroupWrapper()` has a `DIRECTOR` case in the activation strategy handler
- Existing Director runtime logic runs only inside the `DIRECTOR` case
- No Director execution occurs before the strategy switch
- Natural/List/Manual/Pooled do not receive Director instructions
- Default/fallback behavior remains equivalent to existing Natural fallback behavior

## TASK-08: Apply per-group Director history settings
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-07
Acceptance: - Director reads `lookbackDepth` and `countUserMessages` from `getDirectorData(group).settings`
- Lookback depth `0` passes no chat history to Director
- User messages are excluded when `countUserMessages` is `false`
- Large lookback values do not preallocate large arrays or crash
- Existing chat message property names are respected

## TASK-09: Apply per-group prompt placement settings
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-07
Acceptance: - Director prompt injection uses normalized per-group `promptPlacement`
- `relative` and `in_chat` placement types are supported
- `system`, `user`, and `assistant` roles are supported where applicable
- `depth` and `order` are passed to the existing prompt injection APIs when supported
- No second prompt injection mechanism is introduced
- Failed Director generation does not leave stale prompt injections active

## TASK-10: Record Director state and directions
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-08, TASK-09
Acceptance: - Director appends structured records to `group.director.stateHistory`
- Records include timestamp, group/chat identifier, settings used, structured state, and raw output
- `group.director.lastDirections` is updated after successful Director output
- Existing decision/journal format is preserved if already present
- Inspector history is not pruned based on lookback depth

## TASK-11: Implement Director inspector/settings modal
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-10
Acceptance: - `openDirectorInspectorModal()` exists
- Modal uses the project-standard popup helper/import pattern
- Clicking without an active group shows a non-fatal warning and does not create global settings
- Modal includes controls for lookback depth, count user messages, placement type, role, depth, and order
- Lookback/depth inputs allow minimum `0` with no explicit maximum
- Inspector displays last directions, structured state history, raw JSON, and decision history when present
- Raw JSON is rendered with `.text()` or `textContent`, not `innerHTML`
- Saving validates and writes settings to the original group captured when the modal opened
- If the original group no longer exists on save, an error is shown and nothing is saved

## TASK-12: Bind Director inspector button
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-02, TASK-11
Acceptance: - `#rm_group_director_inspector` opens `openDirectorInspectorModal()` on click
- Handler follows nearby group panel binding style
- Button remains usable even when Director is not currently selected
- Modal saves settings through the same persistence path as other group settings

## TASK-13: Verify Director strategy behavior
Priority: P2
Files: public/scripts/group-chats.js (modify), public/index.html (modify)
Depends on: TASK-12
Acceptance: - Strategy dropdown shows Natural, List, Manual, Pooled, and Director
- Old Director checkbox is absent from the DOM
- Existing legacy `director_enabled: true` groups load with Director selected
- Selecting non-Director strategies does not run Director
- Selecting Director runs the moved Director logic
- Modal defaults are lookback `10`, count user messages enabled, placement `Relative`, role `System`
- Modal setting changes persist after reload
- Generated Director state appears in the inspector with structured and raw views
- Lookback depth `0` generation completes without crashing
