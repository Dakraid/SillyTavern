# AI Lorebook Tools and Tool Trace Robustness

**Status**: Implemented
**Phase**: Execute
**Last Updated**: 2026-06-08

---

## Implementation Summary

All task groups (TASK-01 through TASK-06) landed in this change. Key outcomes, verified against the source:

- `ToolManager.invokeFunctionTools` now records a `ToolInvocation` for every model-issued call, including stealth success and stealth error, with `stealth: true` and/or `error: true` flags. `stealthCalls` (the array of stealth tool names) is preserved on the result.
- `public/script.js` writes the processing trace (`extra.processing_trace` and `extra.isProcessingMessage`) to the target message **before** the stealth-only stop check, so aborted/empty responses that triggered a stealth tool still surface the call in the trace UI. The trace attaches only to non-user messages via a new `canAttachToolTraceToMessage` guard.
- A new exported helper `scrubToolProcessingMetadata(message)` removes `extra.tool_invocations`, `extra.processing_trace`, and `extra.isProcessingMessage` in one call. It is invoked from `deleteLastMessage`, `deleteMessage`, the bulk `/del` branch in the jQuery delete-dialog handler, the message swipe reset (`clearMessageData`), and the `Generate` rollback path that removes an empty assistant turn before regenerating.
- A new module-local helper `getToolInvocationFlowState(invocationResult)` returns `{ visibleInvocations, hasVisibleInvocations, hasOnlyStealthInvocations }`. Both the streaming and non-streaming `Generate` paths compute the flow state once and feed only `visibleInvocations` to `ToolManager.saveFunctionToolInvocations`, so stealth-only flows never push a system tool-result message into the chat and never trigger a follow-up generation.
- AI lorebook management surface in `public/scripts/world-info.js` now exposes `load_lore_entries` / `unload_lore_entries` (array of canonical `lorebook::uid` names) alongside the single-entry tools. `list_lore_entries` returns `{ loaded, remainingTurns }` per registry item by calling the new `getAIManagedLoreStatus` helper against the chat metadata state. Batch tools return `{ results: [{ name, success, error? }] }` and persist metadata exactly once per batch when at least one name succeeded.
- `refreshDirectAccessTools` disambiguates colliding sanitized slugs by appending `__<uid>` (then `__2`, `__3`, …) and refuses to register a name that collides with any of the six built-in management tool names (`list_lore_entries`, `load_lore_entry`, `load_lore_entries`, `unload_lore_entry`, `unload_lore_entries`, `get_loaded_lore_entries`). Collisions are surfaced via `console.warn` with a list of `baseToolName → finalToolName` mappings.
- New tests cover: `scrubToolProcessingMetadata` (preserving unrelated `extra` fields), stealth success and error producing traceable invocations while preserving `stealthCalls`, non-stealth error invocations for retry context, `list_lore_entries` exposing `loaded` and `remainingTurns`, batch `load_lore_entries` / `unload_lore_entries` with per-name partial success, and direct-access disambiguation across duplicate slugs and built-in collisions.

### Verification

- Targeted suites pass: `openrouter-tool-call-parsing` 8/8, `world-info-ai-lore-tools` 4/4. Full project suite: 12 suites / 443 tests pass.
- `git diff --check` clean.
- `npm run lint` shows only pre-existing mixed-tabs issues outside this change; the changed `tests/openrouter-tool-call-parsing.test.js`, `tests/world-info-ai-lore-tools.test.js`, and `public/scripts/tool-calling.js` lines are clean. A lint regression in the `sanitizedName` regex was fixed during this change.

### Doc-drift fix

The earlier plan referenced a nonexistent helper `getFunctionToolCallsByMessageId`. The real storage/read path is per-message `extra.tool_invocations` (array of `ToolInvocation`) and `extra.processing_trace` (string), with `extra.isProcessingMessage` as the boolean guard. The processing-trace UI in `public/scripts/reasoning.js` reads `chat[messageId]?.extra?.processing_trace` and `chat[messageId]?.extra?.isProcessingMessage`; the prompt builder in `public/scripts/openai.js` reads `chat[j]?.extra?.tool_invocations`.

---

## Vision

Fix AI lorebook tool failures (tools abort the response before a call appears in the visible processing trace) and refine the AI-managed lorebook management + direct-access tool surface so models can efficiently control which entries are loaded or unloaded in the active context. Add regression coverage around tool invocation, processing-trace persistence, and lorebook load/unload behavior.

### Problem Statement

1. **Stealth tool failures abort responses silently.** When a tool flagged `stealth: true` (e.g. `list_lore_entries`, `get_loaded_lore_entries`) throws, the resulting error is appended to `stealthCalls` and no invocation record is created. The UI processing trace therefore shows no tool activity, even though the model attempted a call. This is the reported "fail to run and abort response before call appears" symptom.
2. **Aborted messages with tool use are hard to delete.** The empty/deleted-response cleanup path in `public/script.js` can race the tool invocation trace, leaving an orphan tool call record on a message that the user then removes. The plan must keep the trace and the message in sync.
3. **Lorebook management tools lack efficient controls.** `load_lore_entry` and `unload_lore_entry` are single-entry and the registry does not expose loaded/unloaded status, forcing the model into multiple round-trips to learn what is currently active.
4. **Direct-access `get_*` tool names can collide.** `refreshDirectAccessTools()` sanitizes entry names into `get_<slug>` and does not detect collisions across lorebooks or with the four built-in management tools. Two entries with identical slugs silently overwrite each other; collisions with built-ins (`get_loaded_lore_entries`, etc.) are unguarded.

### Goals

- Trace persistence is preserved for every model-issued tool call (including stealth) and is consistent with the message lifecycle (including deletion of aborted/empty responses).
- Lorebook management tools expose stable, collision-free identifiers, batch operations, and loaded/unloaded status so models can resolve and act in fewer round-trips.
- Direct-access `get_*` tools never collide with each other or with built-in management tools.
- Regression coverage (unit + targeted integration) covers trace persistence, the abort path, and the management/direct tool behavior.

### Non-Goals

- Reworking the ToolManager core API. Only additive/minimal changes.
- Changing the AI-managed lorebook `aiFunctionName` / `aiDescription` / `aiAutoUnload` entry fields or the `aiManaged` lorebook flag.
- Removing the `WORLDINFO_FORCE_ACTIVATE` / `WorldInfoBuffer.externalActivations` activation mechanism.
- Server-side refactors of background job infrastructure (out of scope for this spec).

---

## Key Decisions

| Decision                            | Choice                                                                                                                            | Rationale                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Stealth tool error visibility       | Always record a trace entry for stealth calls, even on error; mark `stealth: true` and `error: true`                              | Surfacing the call makes failures debuggable without changing the no-follow-up-generation contract |
| Stable entry identifiers            | Continue using `${lorebookName}::${entryUid}` as the canonical id; introduce a separate `uid`-only handle for batch ops           | UID is already unique within a lorebook and stable across renames                                  |
| Batch load/unload                   | Add `load_lore_entries` / `unload_lore_entries` (array) alongside the existing single-entry tools                                 | Models ask for "the dragon lore pack" once instead of N round-trips                                |
| Status in registry                  | `list_lore_entries` includes `loaded: boolean` and `remainingTurns: number` when known                                            | Removes the need for a separate `get_loaded_lore_entries` call before acting                       |
| Direct tool collision policy        | Disambiguate by appending `__<uid>` suffix when sanitized slug collides; reject names that collide with built-in management tools | Preserves per-entry uniqueness without losing human-readable prefix                                |
| Trace persistence on message delete | When a message is removed, strip its tool-call records and any pending stealth trace entries referencing its `messageId`          | Prevents orphan tool rows in the processing trace                                                  |

---

## Current Surface (post-change, verified in `public/scripts/world-info.js` and `public/scripts/tool-calling.js`)

Tools registered in `registerAIManagedLoreTools()`:

- `list_lore_entries` — stealth, optional `lorebook` filter, returns registry items enriched with `{ loaded: boolean, remainingTurns: number }` from chat metadata state.
- `load_lore_entry` — non-stealth, requires `name` (`lorebook::uid`).
- `load_lore_entries` — non-stealth, requires `names: string[]` (`lorebook::uid`); returns `{ results: [{ name, success, error? }] }` and persists metadata once per batch when at least one name succeeded.
- `unload_lore_entry` — non-stealth, requires `name` (`lorebook::uid`).
- `unload_lore_entries` — non-stealth, requires `names: string[]` (`lorebook::uid`); same per-name result shape and single-write metadata persistence as the load batch.
- `get_loaded_lore_entries` — stealth, returns loaded entries with `remainingTurns` (back-compat).
- Direct access tools via `refreshDirectAccessTools()` — one `get_<sanitized>` per registry entry, with collision-safe disambiguation. A name that collides with a previously registered direct tool, or with any of the six built-in management tool names, is renamed to `get_<slug>__<uid>` (or `get_<slug>__<uid>__2`, `__3`, …). Collisions are logged via `console.warn` with a `baseToolName → finalToolName` list.

`ToolManager.invokeFunctionTools` (in `public/scripts/tool-calling.js`) now produces a `ToolInvocation` for every call — non-stealth success, non-stealth error, stealth success, and stealth error. Each entry carries `id`, `displayName`, `name`, `parameters`, `result`, `error: boolean`, `signature`, `reasoning`, and (when applicable) `stealth: true`. `stealthCalls` is still populated with the names of stealth tools invoked, preserving the existing flow contract.

The aborted-response path in `public/script.js` (both streaming and non-streaming) now runs `scrubToolProcessingMetadata` on the message before deletion, and uses `getToolInvocationFlowState` to keep stealth-only calls from triggering a follow-up generation. The processing trace is written to `chat[messageId].extra.processing_trace` and `chat[messageId].extra.isProcessingMessage` before the stealth-only stop check, so an empty/aborted response with a stealth call still surfaces the call in the trace UI.

### Message-extra storage layout (canonical, verified)

- `chat[i].extra.tool_invocations` — `ToolInvocation[]` written by `ToolManager.saveFunctionToolInvocations` to the synthetic system message, and read by the prompt builder in `public/scripts/openai.js` (`setOpenAIMessages`).
- `chat[i].extra.processing_trace` — string of concatenated tool-call traces; read by `public/scripts/reasoning.js` `updateDom` and `appendProcessingTrace`.
- `chat[i].extra.isProcessingMessage` — boolean guard; read by `reasoning.js` and the `coreChat` filter in `Generate` (lines around 5776–5778) to exclude in-flight processing messages from the next prompt while still allowing system messages that carry `tool_invocations` through.

---

## Tasks

## TASK-01: Persist tool trace for stealth calls (including errors) — Implemented

Priority: P0
Files: public/scripts/tool-calling.js (modify)
Depends on: none
Acceptance: - `ToolManager.invokeFunctionTools` records an invocation for stealth calls on both success and error

- Recorded invocation carries `stealth: true` and `error: true` when applicable
- No follow-up generation is triggered for stealth calls (existing contract preserved)
- Trace storage layout is unchanged for non-stealth calls
- The processing-trace UI in `public/scripts/reasoning.js` reads the new entries via `chat[messageId].extra.processing_trace` and `chat[messageId].extra.isProcessingMessage`; the prompt builder in `public/scripts/openai.js` reads `chat[j].extra.tool_invocations`

## TASK-02: Reconcile processing trace with message deletion — Implemented

Priority: P0
Files: public/script.js (modify)
Depends on: TASK-01
Depends on: none
Acceptance: - Deleting an aborted/empty assistant message removes any tool invocations whose `messageId` matches

- Pending stealth tool entries attached to a deleted message are also removed
- Bulk delete of a swiped branch strips tool rows for every removed message
- Trace UI no longer shows orphan tool entries after a delete
- Liking/swiping do not strip tool invocations from the kept sibling

## TASK-03: Add stable batch load/unload and registry status — Implemented

Priority: P0
Files: public/scripts/world-info.js (modify)
Depends on: none
Acceptance: - `load_lore_entries` accepts `names: string[]` (canonical `lorebook::uid`) and loads each

- `unload_lore_entries` accepts `names: string[]` and unloads each
- `list_lore_entries` results include `loaded` (boolean) and `remainingTurns` (number) for each entry
- `get_loaded_lore_entries` is kept for back-compat and returns the same shape as today
- Batch failures are reported per-name; partial success is allowed
- Auto-unload counters behave identically to the single-entry tools

## TASK-04: Harden direct-access tool naming — Implemented

Priority: P1
Files: public/scripts/world-info.js (modify)
Depends on: TASK-03
Acceptance: - Sanitized slugs that collide with another entry in the registry are disambiguated with `__<uid>`

- Names that would collide with built-in management tools (`list_lore_entries`, `load_lore_entry`, `load_lore_entries`, `unload_lore_entry`, `unload_lore_entries`, `get_loaded_lore_entries`) are renamed with the same `__<uid>` suffix
- `refreshDirectAccessTools` is idempotent: repeated calls do not leak registered tools
- Removed entries from the registry cause their direct tools to be unregistered
- Collisions are reported in the console as a non-blocking warning (the lorebook editor integration deferred; `console.warn` is the current surface)

## TASK-05: Regression coverage for tool trace and lorebook tools — Implemented

Priority: P0
Files: tests/ (add or extend)
Depends on: TASK-01, TASK-02, TASK-03, TASK-04
Acceptance: - Unit test: stealth tool success and error both produce a `ToolInvocation` with `stealth: true`

- Unit test: deleting a message removes its tool invocations and any pending stealth trace entries
- Unit test: `list_lore_entries` registry items expose `loaded` and `remainingTurns`
- Unit test: `load_lore_entries` / `unload_lore_entries` accept arrays and report per-name success/failure
- Unit test: direct-access tool name disambiguation prevents collisions
- All existing tests in `tests/` still pass

## TASK-06: Review and verify — Implemented

Priority: P1
Files: (no source changes)
Depends on: TASK-01, TASK-02, TASK-03, TASK-04, TASK-05
Acceptance: - `npm run lint` passes (residual issues are pre-existing mixed-tabs outside this change)

- Targeted Jest runs for the new and adjacent suites pass: `openrouter-tool-call-parsing` 8/8, `world-info-ai-lore-tools` 4/4
- Full project suite: 12 suites / 443 tests pass
- `git diff --check` clean
- A lint regression in the `sanitizedName` regex was fixed during this change
- Manual smoke: trigger a lorebook `list_lore_entries` call, observe the entry in the processing trace even when the response is empty/aborted
- Manual smoke: load and unload a batch of entries in one call; confirm the registry and prompt reflect the change
- Manual smoke: two entries with identical sanitized slugs produce two distinct direct tools

---

## Risks and Open Questions

| Risk / Question                                                        | Mitigation                                                                                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Persisting stealth errors could leak prompt-internal details to the UI | Reuse the same `toolResult.toString()` formatting used for non-stealth errors                                                                             |
| Batch loads could exceed metadata write budgets                        | Persist metadata once per batch action (not per entry)                                                                                                    |
| Direct-tool `__<uid>` suffix may surprise users                        | Document the policy in the lorebook editor and surface a one-line warning when collisions occur (console warning implemented; in-editor surface deferred) |
| Trace scrub on delete may race an in-flight tool                       | Tie the scrub to the same `messageId` written when the tool was invoked; no-op if the row is already gone                                                 |
