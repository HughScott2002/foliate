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
