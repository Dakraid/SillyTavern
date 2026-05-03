# Completion Prompt Manager Wrapper and Bulk Operations Design

Date: 2026-05-03

## Approved scope

- `#completion_prompt_manager` exposes global wrapper settings for persisted chat messages.
- Assistant messages are persisted as `<CharacterTag>message</CharacterTag>` when enabled. In group chats, the tag comes from the actual responding character for each message.
- User messages are persisted as `<PersonaName>message</PersonaName>` when enabled.
- A per-character assistant tag override is stored internally in SillyTavern settings and is not written to character card data or prompt import/export files.
- The same override is editable in both the Character Editor and Completion Prompt Manager.
- Wrapper toggles apply retroactively to the current chat and all stored swipes after a confirmation. Turning on wraps old messages; turning off removes managed or same-tag outer wrappers.
- New assistant/user messages, regenerated replies, swipes, continues, and appends persist exactly one wrapper pair when the matching toggle is enabled.
- Duplicate or malformed same outer tags are normalized to one valid pair while wrapping; same outer tags are removed while unwrapping. Legacy same outer tags are treated as managed wrappers.

## Wrapper format and persistence

- Format: `<Tag>message</Tag>`.
- Tag source:
  - Assistant: character-specific override, then character/message display name, then `Unknown`.
  - User: active persona/message user name, then `Unknown`.
- Tag names preserve display names, including spaces and special characters. `<` and `>` are escaped for tag boundaries.
- Metadata shape for reversible persistence: `extra.prompt_wrapper = { role, tag, base_mes, version: 1 }` on messages and swipe info entries.
- Metadata stores the exact unwrapped base content so toggling off can restore it.

## Prompt Manager UI

- Add a compact wrapper settings block above the prompt list.
- Controls:
  - `Wrap assistant messages with character tags` checkbox.
  - `Wrap user messages with persona tags` checkbox.
  - `Active character tag override` text input when a character is selected.
- Toggle changes require confirmation because they rewrite the current chat.
- The override input saves to the shared internal wrapper setting.

## Character Editor UI

- Add `Assistant wrapper tag override` near core character identity fields.
- The field uses the same internal setting as Prompt Manager.
- Empty value means use the character display name.

## Bulk operations UI

- Add one `Bulk` button to the Completion Prompt Manager footer.
- The button opens a mobile-friendly wizard dialog with large focusable controls.
- Scope is all prompts currently shown in the manager list, including system, marker, and extension prompts.
- Supported operations:
  - Set all Position to Relative.
  - Set all Position to In-chat.
  - Set all Depth to integer `0+`.
  - Set all Order to integer `0+`.
  - Renumber Order from first/last prompt, incrementing or decrementing by 1.
- Inline validation keeps Apply disabled for invalid numeric input.
- After Apply, show a separate confirmation before changing prompts.

## Accessibility and responsive requirements

- All inputs have explicit labels.
- Dialog controls are keyboard focusable and usable without horizontal scrolling at widths down to 412px.
- Invalid numeric values show visible inline error text and disable Apply.
- Confirmation text summarizes the operation and affected prompt count.

## Change journal

- 2026-05-03: Initial approved design recorded from user interview and design deck selections.
