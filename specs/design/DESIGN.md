# Completion Prompt Manager Wrapper and Bulk Operations Design

Date: 2026-05-03

## Approved scope

- `#completion_prompt_manager` exposes per-active-chat wrapper toggles for ephemeral prompt-build tags and display-only chat UI tags.
- Assistant prompt content is sent as `<CharacterTag>message</CharacterTag>` when enabled. In group chats, the tag comes from the actual responding character for each message.
- User prompt content is sent as `<PersonaName>message</PersonaName>` when enabled.
- Saved chat messages and saved swipes remain raw/unwrapped. XML tags are not written to `mes`, `swipes[]`, or new `extra.prompt_wrapper` metadata.
- Assistant/user wrapper enabled state is stored per chat in `chat_metadata.prompt_wrappers = { assistant, user }`; missing metadata seeds once from legacy global wrapper booleans.
- Individual-chat per-character assistant tag overrides are stored internally in SillyTavern settings and are not written to character card data, chat messages, or prompt import/export files.
- Group-chat assistant tag overrides are stored only on the active group chat metadata as `chat_metadata.prompt_wrapper_overrides = { [avatarFilename]: string }`.
- The same individual override is editable in both the Character Editor and Completion Prompt Manager; group chats render one Completion Prompt Manager override input per group member.
- Wrapper toggles are metadata-only. Changing them saves chat metadata, re-renders chat display tags, and changes future prompt-build payloads without rewriting chat text.
- Legacy cleanup is limited to old messages/swipes that already have `extra.prompt_wrapper` metadata from earlier builds. Cleanup restores `base_mes` or strips that metadata tag, deletes the legacy metadata, and saves the chat.

## Wrapper format, prompt build, and display

- Format: `<Tag>message</Tag>`.
- Tag source:
  - Assistant in group chats: active group chat override for the message writer avatar, then individual character override, then character/message display name, then `Unknown`.
  - Assistant in individual chats: individual character override, then character/message display name, then `Unknown`.
  - User: active persona/message user name, then `Unknown`.
- Tag names preserve display names, including spaces and special characters. `<` and `>` are escaped for tag boundaries.
- Prompt-build wrapping happens in the chat-completion message payload only and does not mutate source chat objects.
- Chat UI renders opening/closing XML tag spans separately around formatted message content. Editing a message uses raw `message.mes`, so tags do not appear in edit textareas.
- Narrator, system, small-system, ignored, and non-user/non-assistant messages are not wrapped.

## Prompt Manager UI

- Add a compact wrapper settings block above the prompt list.
- Controls:
  - `Wrap assistant messages with character tags` checkbox.
  - `Wrap user messages with persona tags` checkbox.
  - `Character tag overrides` text inputs.
- Toggle checked states reflect the currently loaded chat; switching chats, characters, or groups re-renders them from that chat's metadata.
- Individual chats show one override input for the selected character. Group chats show one override input per group member.
- Override inputs visually default to each associated character name. Saving a non-empty value stores the override; clearing the input debounces briefly, removes the override entry, and resets the visible value to the character name.
- Toggle changes do not require rewrite confirmation because they only save chat metadata and re-render display-only tags.
- Override input saves are debounced. Individual overrides save internal settings; group overrides save active chat metadata. Display-only assistant tags are re-rendered when assistant wrapping is enabled.

## Character Editor UI

- Add `Assistant wrapper tag override` near core character identity fields.
- The field uses the same internal setting as Prompt Manager.
- Empty value means use the character display name; after debounce, the field resets to the character name and the stored individual override is removed.

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
- 2026-05-03: Follow-up approval changed assistant/user wrapper toggles from global settings to per-active-chat metadata while keeping character tag overrides global/internal.
- 2026-05-03: Corrected wrapper model from persisted chat text to ephemeral prompt-build wrapping plus display-only UI tags; legacy metadata cleanup is one-way migration only.
- 2026-05-03: Scoped assistant tag overrides: individual overrides remain internal per character, while group-chat overrides are per active group chat and keyed by member avatar.
