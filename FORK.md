# Foliate fork changes

As of 2026-11-01, this file records changes maintained in [HughScott2002/foliate](https://github.com/HughScott2002/foliate) beyond the upstream `gtk4` branch. The `foliate-js` submodule points to [HughScott2002/foliate-js](https://github.com/HughScott2002/foliate-js), which carries the renderer changes used here.

## Upstream boundary

These changes are intended to stay in the fork. Pulling upstream commits **into this fork** does not send fork commits upstream. Only an explicit push to an upstream branch or a pull request against upstream would propose them there. When preparing a contribution to upstream, start from upstream `gtk4` and cherry-pick only the specific commits intended for that contribution; do not use this fork branch as the pull request head. This is a workflow boundary, not a technical guarantee against a future explicit push or pull request.

## Changes compared with upstream

### Local narration

- Local neural text to speech is the default. Speech Dispatcher remains selectable in the Narration menu.
- The voice chooser downloads, previews, verifies, repairs, and removes Kokoro, Supertonic 3, and Piper voice packs. Downloads continue if the chooser closes; installed voices work offline. A pack can be saved per book. Supertonic has ten narrator styles, with a global default and a per-book override.
- The app tries to start the optional `foliate-voice` daemon to keep models loaded and synthesize audio through its local API. If it is unavailable, the local engine uses `sherpa-onnx-offline-tts` directly. The daemon executable is not included in this repository or Flatpak manifest.
- GStreamer plays cached sentence audio. A bounded, adaptive queue synthesizes upcoming sentences while the current sentence plays. Pause, stop, and speed controls remain on the bottom bar during narration.
- Narration highlights the spoken sentence. The reader snapshots highlight ranges as text is fetched, so lookahead does not lose the current sentence's highlight.
- Text cleanup handles soft hyphens, ligatures, selected abbreviations, and symbols. EPUB roles are used to skip page labels, note references, and other non-narrative content. Readers may choose to include footnotes and endnotes. Nested-list text and empty text nodes have renderer fixes.

### Zoom, page turns, and chapter audio

- At a chapter boundary, the old chapter stays painted until the new one is laid out. The selected WebView zoom stays in effect, and animated page turns slide directly between chapters without a blank boundary page.
- The paginator prepares the adjacent chapter on each side in hidden frames and releases chapters that are no longer adjacent. Pages within one reflowable chapter already share its laid-out document; this preload concerns chapter boundaries.
- The local narration queue can synthesize the first sentences of the prepared next chapter before the current chapter's audio ends. It changes the visible chapter only when playback reaches that boundary and then uses the prepared text iterator and highlight ranges. If a chapter or audio is not ready in time, playback may still wait.

### Build, settings, and verification

- The Flatpak manifest adds the pinned `sherpa-onnx` 1.13.8 command-line runtime and audio access. Local narration also needs `libsoup-3.0`, GStreamer Play, `tar`, and `bzip2`. Voice packs are downloaded separately.
- GSettings stores the narration backend, text normalizer, footnote choice, and default Supertonic narrator. The FAQ documents the fork's narration controls and voice storage.
- `shell.nix` supplies a NixOS development environment. With the `foliate-js` submodule initialized, `make run` launches Foliate from source, `make run ARGS=/path/to/book.epub` opens a book, and `make test` runs the isolated tests on an existing display. Compiled development schemas go in the ignored `target` directory.
- Tests cover voice-pack lifecycle, daemon and CLI synthesis, playback, narration text and highlights, zoomed chapter turns, adjacent chapter preparation, and audio lookahead.

## Source-build notes

Other source builds need `libsoup-3.0`, GStreamer Play (including the GstPlay typelib, WAV decoding, and an audio-output plugin), `tar`, `bzip2`, and `sherpa-onnx-offline-tts` 1.13.8 on `PATH` for local narration. `FOLIATE_TTS_CMD` can point to that executable. The 2.0 release removes the built-in Piper phonemizer required by this integration.
