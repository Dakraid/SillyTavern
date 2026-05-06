# Per-Group Director Feature

Implement an invisible per-group Director that uses a selected Connection Profile before group replies to update private scene state, manage Director-controlled mutes, and control next-speaker queue without exposing Director messages in chat.

---

## TASK-01: Add Director group typings
Priority: P0
Files: public/global.d.ts (modify)
Depends on: none
Acceptance: Group type includes optional director config and all Director decision/action interfaces compile without TypeScript errors

Add `director?: GroupDirectorConfig` to the existing `Group` interface. Define `GroupDirectorConfig`, `DirectorDecision`, `ParsedDirectorDecision`, `DirectorAction`, and `DirectorAppliedAction` using stable group member identifiers, not display names.
---

## TASK-02: Support profile-specific raw OpenAI requests
Priority: P0
Files: public/scripts/openai.js (modify), public/script.js (modify)
Depends on: TASK-01
Acceptance: Director/raw generation can use a selected Connection Profile without mutating global `oai_settings`

Add helpers to resolve and clone OpenAI/Connection Profile settings by name or id. Extend `sendOpenAIRequest()` and, if needed, `generateRaw()` to accept profile/request options such as:
- `connectionProfile`
- `purpose: 'director'`
- `oaiSettingsOverride`
Direct `oai_settings` reads during request construction must use the override settings when provided.
---

## TASK-03: Verify group backend persistence
Priority: P1
Files: src/endpoints/groups.js (modify)
Depends on: TASK-01
Acceptance: Saving a group preserves the full `director` object through `/api/groups/edit`

Confirm the group edit endpoint persists arbitrary group fields. If the endpoint uses a whitelist, add `director` to the allowed fields. Do not introduce a backend migration.
---

## TASK-04: Add Director config normalization helpers
Priority: P0
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-01
Acceptance: `ensureDirectorConfig(group)` always returns a valid normalized Director config

Implement `getDefaultDirectorConfig()` and `ensureDirectorConfig(group)`.
Normalization must:
- default missing fields
- clamp `lookbackDepth` to `1–100`
- coerce booleans/numbers safely
- initialize `queue`, `controlledDisabledMembers`, and `decisions`
- filter `queue` and `controlledDisabledMembers` to current `group.members`
- preserve full decision history
---

## TASK-05: Build Director lookback context
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-04
Acceptance: Lookback context is chronological and respects user-message counting behavior

Implement `buildDirectorLookback(group, depth, countUserMessages)`.
Behavior:
- skip system messages
- include user messages in context
- when `countUserMessages` is false, user messages do not advance the lookback counter
- character messages always count
- returned messages are chronological
- scanning is capped defensively, e.g. max 500 inspected chat entries
---

## TASK-06: Build Director prompt contract
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-04, TASK-05
Acceptance: Generated prompt contains valid member ids, group state, journal, recent context, and JSON-only response instructions

Implement `buildDirectorPrompt(group, contextMessages)`.
Prompt must include:
- group name
- stable member ids and display names
- active, disabled, manual-disabled, and Director-disabled state
- current queue
- existing Director journal
- recent chat context
- explicit valid member id list
- JSON-only response schema with `journal`, `queue`, `actions`, and `summary`
Do not include full decision history in every prompt.
---

## TASK-07: Parse Director responses and identify manual mutes
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-04
Acceptance: Plain JSON, fenced JSON, and first-object JSON responses parse correctly; malformed responses fail safely

Implement:
- `parseDirectorResponse(raw)`
- `getManualDisabledMembers(group)`
- `reconcileDirectorControlledMutes(group)`
Parsing must strip markdown fences, extract the first JSON object when possible, validate expected fields, and reject invalid structures.
Manual mute logic must treat `group.disabled_members - director.controlledDisabledMembers` as user/manual-disabled members.
---

## TASK-08: Apply Director decisions safely
Priority: P0
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-04, TASK-07
Acceptance: Director can only unmute members it muted and never overrides manual disables

Implement `applyDirectorDecision(group, parsed)`.
Rules:
- `leave` adds valid non-manual-disabled members to `group.disabled_members` and `director.controlledDisabledMembers`
- `enter` only removes members from `group.disabled_members` if they are in `director.controlledDisabledMembers`
- `stay` does not change mute state
- manual-disabled members are never unmuted
- invalid/stale members are ignored
- queue is filtered to valid, non-manual-disabled, currently eligible members
- queue order is preserved and deduplicated
- applied and ignored actions are returned for decision history
---

## TASK-09: Implement Director run orchestration
Priority: P0
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-02, TASK-05, TASK-06, TASK-08
Acceptance: `runDirector(group)` records every attempted decision and fails without blocking normal group generation

Implement `runDirector(group)`.
It must:
- skip when disabled or no profile is selected
- prevent duplicate concurrent runs for the same group
- reconcile Director-controlled mutes before applying
- call `generateRaw()` with the selected connection profile
- store raw response, parsed response, applied actions, errors, timestamp, profile, lookback settings, and input message ids
- save the group after recording the decision
- avoid applying actions if the selected group changed or Director was disabled before completion
- skip safely on missing/deleted/incompatible profile and allow normal generation to continue
---

## TASK-10: Integrate Director into group generation flow
Priority: P0
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-09
Acceptance: Director runs before group speaker selection and its queue overrides speaker order when valid

Integrate `runDirector(group)` into `generateGroupWrapper()` before existing member activation/speaker selection.
Implement `getDirectorActivationOverride(group)`.
Behavior:
- use `director.queue` to produce ordered character ids
- exclude invalid, manually disabled, or currently disabled members
- fall back to existing group speaker selection if queue is empty/invalid or Director fails
- consume the generated speaker from `director.queue` after generation
- save the group after queue consumption
---

## TASK-11: Add Director group settings UI markup
Priority: P2
Files: public/index.html (modify)
Depends on: TASK-01
Acceptance: Group settings UI contains Director enablement, profile, lookback, user-counting, and journal controls

Add a Director settings block near existing group activation/order controls with:
- enabled checkbox
- Director Connection Profile select
- lookback number input, min `1`, max `100`, default `10`
- count user messages checkbox
- Director Journal button
Defaults must be disabled, empty profile, lookback `10`, and count user messages `false`.
---

## TASK-12: Wire Director settings UI behavior
Priority: P1
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-04, TASK-11
Acceptance: Changing Director settings updates the selected group and persists after reload

Implement Director settings loading and event binding.
Requirements:
- populate controls from `ensureDirectorConfig(group)`
- save changes through existing group save/debounce flow
- validate and clamp lookback input
- populate profile dropdown from existing Connection Profiles
- preserve missing selected profiles as disabled options labeled as missing
- use existing notification pattern for non-blocking warnings
---

## TASK-13: Add Director journal and history modal
Priority: P2
Files: public/scripts/group-chats.js (modify)
Depends on: TASK-09, TASK-12
Acceptance: Journal can be edited and all recorded decisions are inspectable from the group UI

Use the existing `Popup` class to implement the Director Journal modal.
Modal must include:
- editable journal textarea
- read-only decision history
- timestamp per decision
- summary when available
- applied actions
- errors
- collapsible raw response text/JSON
Saving the modal updates `director.journal` and persists the group. Decision history must not be editable or automatically pruned.
---

## TASK-14: Validate Director behavior and edge cases
Priority: P1
Files: public/scripts/group-chats.js (modify), public/scripts/openai.js (modify), public/script.js (modify), public/index.html (modify), src/endpoints/groups.js (modify)
Depends on: TASK-10, TASK-12, TASK-13
Acceptance: Manual verification confirms hidden Director operation, persistence, queue ordering, mute safety, and fallback behavior

Verify:
- no Director messages appear in chat
- missing/invalid profiles skip Director and allow normal generation
- invalid JSON records raw response/error and applies no changes
- Director mutes and unmutes only Director-controlled members
- manually disabled members are never re-enabled by Director
- stale/deleted members are filtered from queue and controlled mutes
- queue controls next speaker order and consumed speakers are removed
- journal edits persist per group
- decision history persists per group
- normal group generation works when Director is disabled or fails
