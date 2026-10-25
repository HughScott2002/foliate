# Local Read-Aloud Design

Date: 2026-10-24
Status: approved in conversation (approach A, all three voice packs)

## Intent

Foliate reads books aloud with a natural neural voice, fully local. Open
book → click "Narration" → one-time voice download with progress → it
reads, with controls that stay visible and text that highlights as it
goes. No cloud, no daemon configuration, no GPU.

## Why

Existing narration (speech-dispatcher SSIP, `src/speech.js` + `src/tts.js`)
defaults to espeak-ng and sounds robotic; good voices (Piper) require
manual system daemon config most users never do. No Linux desktop reader
ships in-app neural voice downloads today (StoryCodex does it on mobile).

## Goals

- One-click voice pack download inside the app, with sizes and preview
- Neural narration via a bundled sherpa-onnx engine subprocess
- Persistent playback controls while narrating (play/pause/stop/speed)
- Sentence/word highlight synced to audio (read-along), auto page-turn
- Voice auto-picked from book language

## Non-goals

- Cloud TTS; voice cloning; GPU requirement; removing speech-dispatcher
  path (stays for accessibility); TTS of DRM'd content bypass.

## Models (research 2026-10)

All three run on one engine: sherpa-onnx (ONNX Runtime, int8).

| Pack | Size | Languages | License | Role |
|---|---|---|---|---|
| Kokoro-82M int8 | ~141 MB | en, zh | Apache-2.0 | default |
| Supertonic 3 int8 | ~123 MB | 31 | MIT | multilingual |
| Piper Amy low (VITS) | ~64 MB | en | see upstream model card | slow machines |

Weights downloaded at runtime from upstream releases. Model licensing is
separate from engine licensing; retain each pack's upstream license/model
card. Engine binary ships with the app.

## Approaches considered

A. **Bundled sherpa-onnx engine + downloadable packs** (chosen) — full
   control of quality, sync, and UX; one new runtime dependency.
B. Auto-configure speech-dispatcher with Piper — least code, but daemon
   quirks (multi-second sentence pauses, no word marks), system-wide
   config, still not simple. Rejected.
C. Run kokoro-js in the WebKit view — no native dep, but WASM speed in
   WebKitGTK unproven, memory heavy. Rejected.

## Decisions

- Engine = prebuilt `sherpa-onnx` CLI (`sherpa-onnx-offline-tts`) driven
  per sentence; wav per sentence cached in `XDG_CACHE_HOME`; playback via
  GStreamer; highlight driven by sentence marks (word marks where the
  model exposes token timestamps).
- Packs stored in `XDG_DATA_HOME/foliate/voices/<pack>/`; manifest with
  sizes, URLs, SHA-256, languages, sample clip.
- Reuse foliate-js TTS mark pipeline (SSML → per-sentence text + Range
  map) — swap the backend, keep the webview plumbing.
- Pack download with progress → toast on completion; per-book voice
  choice in per-book JSON storage.
- Flatpak: add GStreamer runtime + `--socket=pulseaudio`; network already
  present (`--share=network`).
- NixOS dev: sherpa-onnx release tarball in the dev shell (autoPatchelf).
- Runtime pinned to 1.13.8: 2.0 removed the built-in Piper phonemizer.
- Preview samples are synthesized locally after installation, not bundled clips.

## Left to the builder

- Exact pack URLs/SHA (pin at implementation time).
- Word-timestamp plumbing if Kokoro token durations prove awkward:
  sentence highlight first, word marks as a stretch.

## Flow (as built)

Narration is one continuous sentence stream, not one block at a time:

- `tts.js #speakStream` builds a sentence stream; `LocalTTSPlayer.playStream`
  pulls blocks **ahead of playback** (adaptive window 2..16, default 4) so a
  block's sentences are fetched and synthesized while the previous block is
  still being read aloud. No synthesis lands on the speaker at a paragraph
  boundary.
- A **section boundary** is a different thing: the source returns a
  `SECTION_END` marker, which lookahead may discover but never crosses. The
  queue holds at the boundary and pages the renderer only when playback
  actually reaches it (`onSectionEnd`). So the page turns neither early nor
  clears highlight state a still-playing sentence needs. Cost: one synthesis
  on the critical path per section (the first sentence of the next section),
  which is the accepted trade for a correct page turn.
- Window adapts to the measured real-time factor (synth ms / audio ms): grows
  on headroom, shrinks under load, floored at 2 so at least one sentence is
  always synthesized ahead. Per-sentence `narrate:` debug line makes flow
  auditable.
- The model is warmed at book open (primer) so first Play has no model-load
  wait (primer is skipped unless the daemon is up, so it never occupies the
  one-shot CLI engine's slot).
- Lookahead advances foliate-js's iterator past the sentence being read,
  overwriting its mark→range map; the reader snapshots each fetched block's
  ranges under a `seq`, so the read-along highlight always uses the playing
  sentence's own block. Snapshots are pruned to the recent window.
- Deferred: PCM streaming of the first sentence (helps kokoro; supertonic,
  the default, is already under the ~0.5s first-audio target).

## Text normalization (as built)

`src/tts-normalize.js` exposes one stable entry point, `normalizeText(text,
lang)`, and nothing else in the app touches the backend. The backend is
chosen at startup from the `tts-normalizer` setting:

- `rules` (default) — a conservative, English-first built-in ruleset: soft
  hyphens removed, line-break hyphens joined, ligatures expanded, a small
  abbreviation set expanded, symbols (`&`, `§`, `+`, `=`, `%`, `$`, dashes,
  ellipsis) rendered as words. Universal cleanups run for any language;
  English-only rewrites (symbols, currency, abbreviations) are gated on the
  language. This is deliberately **not** a complete normalizer.
- `none` — identity; something downstream normalizes instead.
- `fst` — reserved for NeMo/WeTextProcessing-style grammars compiled to
  OpenFst FSTs (run by the engine, not by JavaScript). Until it is wired in
  it behaves as `none`, so the two never both run and double-normalize.

There is no complete TTS text normalizer in plain JavaScript: the complete
ones are Python/FST (NeMo), and the JS ones that exist target ASR/WER
canonicalization, the wrong direction. So the *interface* is built now and
the completeness comes from the `fst` backend later — callers never change.
Normalization is pure and microseconds-fast, so it has no cache of its own:
the audio cache keys on the normalized text. Highlight marks are unaffected.
Applies to the local pipeline; speech-dispatcher keeps its own SSIP text.
DOM-level stripping (footnote markers, running heads) is deferred.
