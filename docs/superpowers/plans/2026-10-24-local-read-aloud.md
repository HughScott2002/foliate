# Local Read-Aloud Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Neural local narration in Foliate: one-click voice pack download, bundled sherpa-onnx engine, persistent playback bar, read-along highlighting.

**Architecture:** Keep the existing foliate-js SSML/mark pipeline in the WebView; replace the speech-dispatcher backend with a local engine controller that spawns the bundled `sherpa-onnx-offline-tts` CLI per sentence, caches wavs, and plays them through GStreamer, advancing the webview marks as audio progresses.

**Tech Stack:** GJS/GTK4/libadwaita, WebKitGTK, sherpa-onnx (int8 ONNX voices), GStreamer (playback), libsoup or Gio.File copy for downloads.

**Spec:** `docs/superpowers/specs/2026-10-24-local-read-aloud-design.md`

## Global Constraints

- Weights download at runtime from upstream releases; nothing GPL ships in the Flatpak.
- Packs live in `XDG_DATA_HOME/foliate/voices/<pack-id>/`; wavs in `XDG_CACHE_HOME`.
- All three packs (Kokoro, Supertonic 3, Piper) are offered; Kokoro is default.
- Existing speech-dispatcher and media-overlay backends keep working untouched.
- NixOS machine: new native tools go through the dev shell (`nix-shell -p …`), never system install.

## Review Focus

- Interrupt mid-sentence (user hits stop/pause or closes the book) → synth subprocess and GStreamer pipeline stop, no orphan audio, next start is clean.
- Pack download fails partway (network cut) → partial dir is cleaned, next attempt restarts, no corrupt "installed" state.
- Pack deleted from disk while selected → app falls back to picker UI, no crash on play.
- Book whose language matches no installed pack → auto-pick suggests/download prompt instead of silence.
- Long section (hundreds of sentences) → synth-ahead queue bounded (a few sentences), memory flat.

---

### Task 1: Voice pack catalog module

**Files:**
- Create: `src/voice-packs.js`
- Test: `tests/voice-packs-test.mjs` (run with `gjs -m`)

**Interfaces:**
- Produces: `getPacks()` → `[{id, label, sizeMB, languages, defaultVoice, urls, sha256, sample}]`; `packDir(id)`; `getInstalledPacks()`; `download(pack, onProgress)` (async, cancellable); `deletePack(id)`; `verifyPack(pack)`.

- [ ] **Step 1: Write the failing test**

```js
import { getPacks, packDir, verifyPack } from '../src/voice-packs.js'
const packs = getPacks()
assert(packs.length === 3)
assert(packs.find(p => p.id === 'kokoro').sizeMB > 100)
assert(packDir('kokoro').endsWith('/foliate/voices/kokoro'))
```

- [ ] **Step 2: Run test to verify it fails**

Run: `nix-shell -p gjs gobject-introspection --run 'gjs -m tests/voice-packs-test.mjs'`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/voice-packs.js`**

Static catalog (the three packs with pinned upstream URLs + SHA-256
placeholders), `XDG_DATA_HOME` path math, and a `download()` that streams
to `…/voices/<id>.part` then atomically renames after checksum verify.
Gio.File `copy_async` with progress callback; `Cancellable` from caller.

- [ ] **Step 4: Run test to verify it passes**
- [ ] **Step 5: Commit** — `feat(tts): add voice pack catalog module`

### Task 2: Pack download/verify round-trip

**Files:**
- Modify: `src/voice-packs.js`
- Test: `tests/voice-packs-test.mjs`

**Interfaces:**
- Consumes: Task 1 catalog + `download()`.
- Produces: a `verifyPack(pack)` that checks all files + SHA-256; `deletePack(id)` that removes dir.

- [ ] **Step 1: Write the failing test** — download a tiny stub URL (local `http.server` on a fixture file) via `download()` with a fake pack entry, assert file lands and checksum verifies.
- [ ] **Step 2: Run test, expect FAIL**
- [ ] **Step 3: Implement streaming download + atomic rename + SHA-256 via `Gio.Bytes`/`GLib.compute_checksum`**
- [ ] **Step 4: Run test, expect PASS**
- [ ] **Step 5: Commit** — `feat(tts): verify and store voice packs`

### Task 3: Engine controller (synth one sentence)

**Files:**
- Create: `src/local-tts.js`
- Test: `tests/local-tts-test.mjs`

**Interfaces:**
- Consumes: `packDir(id)`; bundled CLI at `pkg.bindir`/dev env override `FOLIATE_TTS_CMD`.
- Produces: `LocalTTS` class: `async synth(text, pack, voice) → {wavPath, duration}`, `stopAll()`; kills subprocess on cancel.

- [ ] **Step 1: Write failing test** — synth "Hello world." with the dev-installed pack into a temp wav; assert wav exists and is non-empty (skip if no pack installed: mark manual).
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement subprocess wrapper** — `Gio.Subprocess` invoking `sherpa-onnx-offline-tts --vits/kokoro flags… --output-filename <cache>/sha1.wav`; parse nothing from stdout (CLI writes the file); hash text → cache filename so repeats are free.
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** — `feat(tts): local neural engine controller`

### Task 4: Playback queue + GStreamer

**Files:**
- Modify: `src/local-tts.js`
- Test: `tests/local-tts-test.mjs` + harness screenshot

**Interfaces:**
- Consumes: Task 3 `synth()`.
- Produces: `play(text, {onMark})` with synth-ahead window of 2, `pause()/resume()/stop()`, `setRate(0.75–2.0)` via GStreamer, `duration` from wav header.

- [ ] **Step 1: Write failing test** — queue three sentences, assert only ≤2 synth subprocesses alive at once; stop() leaves zero.
- [ ] **Step 2: Run, expect FAIL**
- [ ] **Step 3: Implement queue + `Gst.Play` (playbin) playback, `set_rate via seek`**
- [ ] **Step 4: Run, expect PASS**
- [ ] **Step 5: Commit** — `feat(tts): queued neural playback`

### Task 5: NarrationBox backend switch

**Files:**
- Modify: `src/tts.js`, `src/book-viewer.js:710-722`, `src/ui/tts-box.ui`, `src/ui/navbar.ui`

**Interfaces:**
- Consumes: Task 4 `play()`; existing webview `initTTS`/`from(range)` SSML path (`book-viewer.js:916`).
- Produces: backend property on `FoliateTTSBox` (`'local' | 'speechd' | 'media-overlay'`); play/pause/stop buttons bound to `LocalTTS`; mark events → existing `highlight` signal; navbar stays revealed while playing (autohide `shouldStayVisible` gains `|| narrating`).

- [ ] **Step 1: Add backend wiring behind a GSettings key `tts-backend` (default `local`) with fallback to speechd when no pack installed**
- [ ] **Step 2: Harness run: start narration on a book with installed pack, screenshot mid-sentence, verify (vision subagent) playback bar visible + sentence highlighted**
- [ ] **Step 3: Commit** — `feat(tts): neural narration backend`

### Task 6: Voice manager UI

**Files:**
- Create: `src/voice-manager.js`, `src/ui/voice-manager.ui`
- Modify: `src/ui/tts-box.ui` (voice picker row), gschema

**Interfaces:**
- Consumes: `getPacks/getInstalledPacks/download/deletePack`.
- Produces: `VoiceManagerDialog` (Adw.Dialog): pack rows with label, size, languages, inline preview sample (bundled 3s clips), download progress bar, delete; "installed" badge; per-book voice choice persisted via `BookData`.

- [ ] **Step 1: Harness screenshot: open dialog, verify pack list renders (3 rows, sizes match catalog) via vision subagent**
- [ ] **Step 2: Implement rows + actions + progress toasts**
- [ ] **Step 3: Harness run: download stub pack, assert progress bar → installed badge transition**
- [ ] **Step 4: Commit** — `feat(tts): voice manager with downloads**

### Task 7: Language auto-pick + polish

**Files:**
- Modify: `src/book-viewer.js`, `src/voice-packs.js`, `data/com.github.johnfactotum.Foliate.gschema.xml`, `com.github.johnfactotum.Foliate.json`, `docs/faq.md`

**Interfaces:**
- Consumes: book `languageMap` → `pickPackForLanguage(lang)` from Task 1 catalog.
- Produces: narration start flow: if no pack for book language → voice manager opens with the right pack preselected.

- [ ] **Step 1: Failing test for `pickPackForLanguage('fr') → 'supertonic'`, `'en' → 'kokoro'`**
- [ ] **Step 2: Run, expect FAIL; implement mapping; PASS**
- [ ] **Step 3: Flatpak manifest: add GStreamer runtime + `--socket=pulseaudio`; dev shell note in README**
- [ ] **Step 4: Full harness flow: fresh state → download prompt → narration with highlight; vision subagent verdict**
- [ ] **Step 5: Commit** — `feat(tts): language auto-pick and packaging`

## Open dev-env items (resolve at Task 3)

- sherpa-onnx CLI availability in `nix-shell` (nixpkgs has `sherpa-onnx`? else GitHub release tarball + autoPatchelf in a `shell.nix`).
- Pin final upstream URLs + SHA-256 per pack in Task 1 placeholders.