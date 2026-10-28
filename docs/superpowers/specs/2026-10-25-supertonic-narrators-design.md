# Supertonic Narrators Design

**Status:** approved

## Intent

Expose all ten Supertonic 3 narrator presets already present in Foliate's
downloaded `voice.bin`. Users choose a default narrator once, while a book
quietly remembers a different narrator when its reader selects one.

## Goals

- Give each official Supertonic preset a human-friendly name and an accurate,
  short description.
- Make the default narrator selectable in Preferences.
- Make the current book's voice picker start at its last selected narrator,
  otherwise at the default narrator.
- Keep Supertonic language selection automatic from the book language.
- Change the local daemon's selected narrator without restarting it.
- Keep Kokoro, Piper, and Speech Dispatcher behavior unchanged.

## Non-goals

- New model downloads or custom voices.
- Emotion controls or inserting Supertonic expression tags into book text.
- User-facing wording such as "override" or a separate language picker.
- Claims about a voice's age where Supertonic has not documented one.

## Narrator labels

| SID | Preset | Display name | Description |
| ---: | --- | --- | --- |
| 0 | F1 | Amy | Calm and steady |
| 1 | F2 | Lily | Bright and playful |
| 2 | F3 | Clara | Clear announcer |
| 3 | F4 | Vivian | Crisp and confident |
| 4 | F5 | Grace | Kind and gentle |
| 5 | M1 | Leo | Lively and upbeat |
| 6 | M2 | Graham | Deep and composed |
| 7 | M3 | Victor | Authoritative and polished |
| 8 | M4 | Elliot | Gentle and friendly |
| 9 | M5 | Theo | Warm storyteller |

The descriptions come from Supertonic's official `voices.md`; the fictional
names are Foliate labels, not claims that the presets represent people.

## Behavior

### Default narrator

`com.github.johnfactotum.Foliate.viewer` gains an integer
`tts-supertonic-sid` setting with a range of `0..9` and default `0` (Amy/F1).
The view Preferences dialog gains a Narration page with a "Default narrator"
combo row. It shows the same names and descriptions as the book picker.

### Book narrator

Per-book JSON storage gains `tts-supertonic-sid` only after the reader selects
a Supertonic narrator for that book. When a book opens, its stored SID is used
if present; otherwise Foliate uses the global setting. The book's voice dialog
shows that effective narrator as selected. Choosing a Supertonic narrator and
pressing Use stores it with the current book. No scope terminology appears in
the UI.

Changing the global setting affects books without a stored narrator selection;
books that already selected one keep their last choice.

`BookData` already provides this storage: it uses Foliate's central JSON file
keyed by the existing book identifier, not a sidecar file or EPUB mutation.
There is no migration: existing books have no narrator key and therefore use
the existing F1/SID 0 behavior through the new global default.

### Synthesis and daemon routing

Foliate carries the effective SID from `BookViewer` to `TTSBox`, then to the
local player and synthesis request. Cache keys continue to include the SID.
Book language already comes from the primary EPUB metadata language in
`BookViewer`, with `en` as fallback. Supertonic's static 31-language pack
catalog supplies daemon entries; `voice.bin` contains all ten official style
vectors for every one of those language entries.

Rather than restarting the daemon whenever a narrator changes, its generated
configuration includes an entry for every installed Supertonic language and
SID. Labels are unique, for example `supertonic-en-f1` and
`supertonic-en-m3`; requests choose the matching label. This permits previews
and book-specific narration to switch promptly while sharing one loaded model.
The direct CLI fallback receives the same SID.

The current CLI already accepts `--sid`; the daemon request and its generated
label need the selected SID added. This avoids a migration or cache invalidation
because the current cache key already hashes pack ID, SID, language, and text.

## Approaches considered

1. **Global default with per-book remembered selection (chosen).** Matches the
   requested reader experience without extra scope language.
2. Global-only choice. Smaller but cannot give books different narrators.
3. Restart the daemon with a single selected SID. Fewer generated daemon
   entries but makes switching, previewing, and settings changes disruptive.

## Builder decisions

- Preferences has no Narration page today. Add one `AdwPreferencesPage` with
  a single `AdwComboRow`; do not change the existing Font, Layout, Color, or
  Behavior pages.
- The book picker is currently a flat pack chooser. Its Supertonic-specific
  narrator selector shows the effective name normally; it does not reveal
  whether the value came from a book record or global settings.
- The named styles use the same `voice.bin` vectors for every catalog language;
  no runtime scan or per-language model download is needed.

## Files expected to change

- `data/com.github.johnfactotum.Foliate.gschema.xml`
- `src/book-viewer.js`
- `src/tts.js`
- `src/voice-daemon.js`
- `src/voice-manager.js`
- `src/ui/view-preferences-window.ui`
- Existing focused narration, daemon, manager, and language tests.

## Verification

- Existing books begin with the global default, then retain their selected
  narrator after reopening.
- A new global default affects a book with no saved narrator selection.
- Every F1--F5 and M1--M5 selection produces the correct daemon label and
  direct-CLI SID; cache entries do not collide.
- Preview and narration work in more than one Supertonic language.
- Kokoro, Piper, and Speech Dispatcher regression coverage stays green.
- Run `make test`; run the real-engine smoke and narration integration checks
  when voice assets are available.
