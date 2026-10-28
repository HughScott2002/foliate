# Global defaults and remembered book settings UX

Date: 2026-10-25

## Decision

Foliate will use a two-level setting model:

1. Preferences sets the default narrator.
2. The reader's existing voice dialog sets the narrator for the open book and
   remembers it silently.
3. “Reset to Default Narrator” returns the book to the current Preferences
   value.

The interface does not say “override”, “inherited”, or “custom”. Scope is
communicated by location: Preferences affects defaults; the reader dialog
affects the open book.

## References used

| Product | Verified behavior | Foliate adaptation |
| --- | --- | --- |
| [BookFusion](https://www.blog.bookfusion.com/webtext-to-speech-tts-shared-settings-across-books-more/) | Reader Audio settings contain voice selection; its shared-settings release says choices apply to subsequent books. | Keep voice selection in Foliate's existing reader-level voice dialog; put the default in Preferences. |
| [Thorium Reader](https://github.com/edrlab/thorium-reader) | Its reader voice selector prioritizes a publication's declared language; its persisted defaults retain a voice per language. Source: [`voiceSelection.tsx`](https://github.com/edrlab/thorium-reader/blob/develop/src/renderer/reader/components/header/voiceSelection.tsx), [`ReaderHeader.tsx`](https://github.com/edrlab/thorium-reader/blob/develop/src/renderer/reader/components/ReaderHeader.tsx). | Keep Foliate's automatic metadata-language selection; do not add a language selector for one Supertonic model. |
| [Firefox zoom](https://support.mozilla.org/en-US/kb/font-size-and-zoom-increase-size-of-web-pages) | A site remembers its zoom; reset returns to the configured default, not a hard-coded value. The UI avoids “override” terminology. Source: [`browser-fullZoom.js`](https://github.com/mozilla/gecko-dev/blob/master/browser/components/tabbrowser/content/browser-fullZoom.js). | “Reset to Default Narrator” clears the book value and follows the current global narrator. No badge or scope label. |
| [GNOME Libadwaita](https://gnome.pages.gitlab.gnome.org/libadwaita/doc/main/class.ComboRow.html) | `AdwComboRow` is the native accessible row for a finite choice list and tracks a selected item. | Use `AdwComboRow` in Preferences and the existing Foliate dialog rather than a new custom control or extra popover. |

## Excluded reference

KOReader core has no native TTS and its major TTS plugins store voice settings
globally, not per document. It is not a direct reference for this feature.
Evidence: [KOReader issue #14906](https://github.com/koreader/koreader/issues/14906)
and the draft Android plugin implementation discussed in
[PR #14946](https://github.com/koreader/koreader/pull/14946).

## Local reuse

- `src/ui/export-dialog.ui` and `src/ui/view-preferences-window.ui` already
  use `AdwComboRow` backed by `GtkStringList`.
- `src/book-viewer.js` already binds numeric GSettings data classes to a combo
  row's `selected` property.
- `src/voice-manager.js` already owns the reader voice flow, including
  selectable rows, preview, explicit Use, and More Actions.
