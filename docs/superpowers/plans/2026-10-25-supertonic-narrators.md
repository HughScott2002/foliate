# Supertonic Narrators Implementation Plan

> **For the implementation controller:** use `superpowers:subagent-driven-development` after plan approval. Delegate only narrow, non-overlapping tasks to `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free` (or another verified `:free` OpenRouter model). Do not use paid models. The controller reads every diff and runs every claimed check.

**Goal:** Let readers choose one of ten verified Supertonic 3 narrator styles as
a global default, then silently remember a different choice for a book.

**Architecture:** One canonical Supertonic narrator catalogue maps `SID → preset →
display name → short description`. GSettings owns default SID. Book JSON owns a
nullable SID: a number wins; missing/null follows GSettings. `BookViewer` resolves
that effective SID, and passes it to `TTSBox`, preview, CLI synthesis, and the
daemon. The daemon registers every Supertonic language × SID label at startup,
so switching styles never restarts it.

**Tech:** GJS, GTK4/libadwaita, GSettings, Foliate `JSONStorage`, existing local
TTS daemon and isolated GJS tests.

**Design:** `docs/superpowers/specs/2026-10-25-supertonic-narrators-design.md`

**UX research:** `docs/research/2026-10-25-default-and-book-setting-ux.md`

## Fixed product decisions

- Default narrator: GSettings key `tts-supertonic-sid`, unsigned integer range
  `0..9`, default `0` (Amy/F1).
- Per-book value: JSON key `tts-supertonic-sid`. A valid number is that book’s
  narrator; missing or `null` follows the current GSettings default.
- Selecting a narrator in the book dialog takes effect only after its existing
  **Use** action succeeds. The dialog preserves its explicit-download behavior.
- **Reset to Default Narrator** takes effect immediately: store `null`, update
  the dialog to current global selection, and do not write a book-specific SID
  if the user subsequently presses **Use** without choosing a narrator again.
- A narrator change applies to the next narration start. It must not restart an
  active stream; the Voice Manager already stops narration before it opens.
- Unsupported book languages keep today’s behavior: the daemon has no matching
  label, synthesis falls back to the CLI engine, and that fallback must still
  receive the selected SID.
- Preferences and book dialog show `Name — description`. Do not show “override”,
  “inherited”, “custom”, a scope badge, or a language selector.
- Names/SIDs: Amy/F1/0, Lily/F2/1, Clara/F3/2, Vivian/F4/3, Grace/F5/4,
  Leo/M1/5, Graham/M2/6, Victor/M3/7, Elliot/M4/8, Theo/M5/9.
- Descriptions must remain grounded in Supertonic’s official voice guide:
  Calm and steady; Bright and playful; Clear announcer; Crisp and confident;
  Kind and gentle; Lively and upbeat; Deep and composed; Authoritative and
  polished; Gentle and friendly; Warm storyteller. Do not add age claims.
- Kokoro, Piper, Speech Dispatcher, pack selection, downloads, repairs, and
  model assets keep their current behavior.

## Global worker contract

Give every free worker this brief verbatim before its task-specific instructions:

```text
You are making one narrow change in Foliate’s dirty feat/local-read-aloud checkout.
Read every listed source and test file before editing. Preserve all unrelated
uncommitted work. Do not run git reset, checkout, restore, clean, stash, commit,
push, install dependencies, edit AGENTS.md/CLAUDE.md, or touch files outside the
task list. Start by adding the requested failing regression test, run only that
test through tests/run-isolated-tests.sh, then make the smallest implementation
pass it. Do not invent APIs, UI state, strings, model capability, or test results.
If a required assumption is false, stop and report it with file/line evidence.
When done, report: changed files, exact commands run with exit status, remaining
risks, and no claim beyond observed output. Do not commit.
```

Controller rules:

- Tasks 1 → 4 are sequential because later tasks consume earlier interfaces.
  Do not run free workers concurrently on shared files.
- Use `tests/run-isolated-tests.sh <test>` for all focused tests. It owns the
  scratch XDG roots; never point a test at the real voice-pack directory.
- Review the actual diff after each task. Reject broad formatting, copied UI
  frameworks, invented voice traits, new downloads, or changes to non-Supertonic
  engines.
- Worktree is deliberately unresolved before execution: the required local-TTS
  baseline is uncommitted in this checkout. Do not create an empty worktree and
  accidentally omit that baseline. Obtain a safe-copy strategy from the user
  before source edits if isolation is required.

## Task 1: Canonical narrator catalogue and validation

**Files:** modify `src/voice-packs.js`, `po/POTFILES`,
`tests/voice-language-test.mjs`.

1. Add failing assertions for all ten records in exact SID order, each official
   preset code, each Foliate display name, and each approved short description.
   Assert explicit `0` remains valid, a valid book SID wins over a fallback, and
   `undefined`, `null`, out-of-range, non-integer, or corrupt SIDs fall back to
   the supplied valid default (or `0` if that fallback is invalid).
2. Add one canonical exported narrator catalogue, plus small exported lookup and
   resolver helpers. Use the catalogue for both style lookup and a formatted
   `Name — description` choice label. Keep gettext calls statically visible for
   names/descriptions so extraction can find them. Export exactly these
   interfaces for later tasks:
   - `NARRATORS`: ten `{ sid, preset, name, description }` records in SID order.
   - `narratorLabel(sid)`: `Name — description`, or the F1 label for an invalid
     SID.
   - `presetCodeForSid(sid)`: `f1` … `m5`, or `f1` for an invalid SID.
   - `resolveNarratorSid({ stored, globalSid })` → `{ sid, followsDefault }`:
     `followsDefault` is true only when `stored` is `null`/`undefined`/invalid;
     a valid `stored` number, including `0`, wins and sets it false. `sid` is the
     valid stored value, else the valid `globalSid`, else `0`.
3. Do not alter `getPacks()`, Supertonic’s pack-level `sid: 0`, supported
   languages, URLs, checksums, or automatic pack selection.
4. Run:
   ```sh
   nix-shell --run 'sh tests/run-isolated-tests.sh tests/voice-language-test.mjs'
   ```

**Acceptance:** one source of truth represents F1–F5/M1–M5 in SID 0–9 order;
only valid values reach later routing code; existing pack language tests remain
green.

## Task 2: Carry selected SID through daemon and direct synthesis

**Files:** modify `src/voice-daemon.js`, `src/local-tts.js`,
`tests/local-tts-test.mjs`; add `tests/voice-daemon-test.mjs`.

1. Write failing daemon tests against exported helpers. With the real
   Supertonic catalog, assert generated TOML has exactly 31 × 10 `[[voices]]`
   entries, one unique label for each language/style pair, and exact examples:
   `supertonic-en-f1` has `sid = 0`; `supertonic-fr-m5` has `sid = 9`.
   Add a round-trip assertion over every language × SID pair: the label from
   `daemonVoiceLabel(supertonic, lang, sid)` appears exactly once in the TOML,
   and that `[[voices]]` block carries the same `sid` and `lang`. Assert
   `daemonVoiceLabel(kokoro, 'en', 23)`, `daemonVoiceLabel(piper, 'en', 0)`, and
   both again with `sid = 9` all return the bare pack id. Assert Kokoro/Piper
   still produce their current one-label entries.
2. Make daemon label construction accept the effective SID and derive its suffix
   from Task 1’s `presetCodeForSid`, never from a display name. The
   non-Supertonic branch must ignore the `sid` argument entirely. Export
   `daemonConfig(packs)` and `daemonVoiceLabel(pack, lang, sid)` as pure test
   seams. Generate all Supertonic entries from the catalogue, not a second
   numeric loop.
3. Export the `VoiceDaemon` class and let its constructor accept
   `{ session = new Soup.Session(), baseUri = null }`. With `baseUri` set it must
   not spawn a process, and `running` reports true so `LocalTTS` can use it as a
   fixture. Extend `#synthUnlocked()` and the public `synth()` option object to
   receive `sid`, then request the label from step 2. Change `LocalTTS.synth()`
   to pass its already-resolved `sidUsed` to the daemon path. Keep its existing
   CLI `--sid` and cache key behavior unchanged.
4. Extend the fake-engine regression to prove SID 9 reaches the Supertonic CLI
   argument list and creates a distinct cache entry. Add a real request-path
   test: a `Soup.Server` fixture records each request body, `VoiceDaemon` is
   constructed with that `baseUri`, and `synth(..., { lang: 'fr', sid: 9 })`
   posts `voice: "supertonic-fr-m5"`. Separately, with `LocalTTS` and a recording
   fake daemon, assert SID 0 and SID 9 produce different `wavPath`s and that
   repeating SID 9 is a cache hit with no second `synth` call. Assert a language
   outside `pack.languages` falls back to
   the CLI engine and its argv still carries `--sid=<selected>`. Build real
   fixture pack files and use the existing fake engine so the readiness gate
   remains exercised rather than bypassed.
5. Run:
   ```sh
   nix-shell --run 'sh tests/run-isolated-tests.sh tests/voice-daemon-test.mjs tests/local-tts-test.mjs'
   ```

**Acceptance:** daemon and CLI synthesize the selected SID; every configured
daemon label resolves to an installed Supertonic model/style without process
restart; non-Supertonic packs retain their pack SIDs and labels.

## Task 3: Default narrator Preferences setting

**Files:** modify `data/com.github.johnfactotum.Foliate.gschema.xml`,
`src/book-viewer.js`, `src/ui/view-preferences-window.ui`,
`tests/run-isolated-tests.sh`; add `tests/view-preferences-test.mjs`.

1. Extend the isolated harness: when `FOLIATE_TEST_SCHEMA_XML` names a schema
   file, compile it with `glib-compile-schemas` into `$root/schemas` and export
   `GSETTINGS_SCHEMA_DIR` before starting `gjs`. Keep
   `GSETTINGS_BACKEND=memory`; the backend stores values, the schema dir defines
   them. Without the variable the harness must behave exactly as today.
2. Start with a focused test run through that harness. Verify
   `tts-supertonic-sid` is a `uint`, defaults to 0, and rejects `10` and `-1`
   without changing the stored value. Instantiate the Preferences dialog with
   its narration settings model; verify a ten-item `AdwComboRow`, first and last
   human-readable labels, and a middle binding: selecting row 5 shows Leo’s
   label and persists `5`, while setting `5` selects row 5. Assert bidirectional
   row selection and GSettings persistence. A reordered `GtkStringList` must
   fail this test.
3. Add `tts-supertonic-sid` to the viewer schema as `type="u"` with an explicit
   `0..9` range and `0` default. Do not add a pack setting or migrate existing
   book data.
4. In `book-viewer.js`, define/export a `NarrationSettings` data class with the
   matching `uint` property. Bind it to `viewer` GSettings once per BookViewer,
   pass it to `ViewPreferencesWindow`, and unbind it in `vfunc_unroot()` beside
   the existing font/view settings.
5. Add a fifth `AdwPreferencesPage`, title **Narration**, icon
   `audio-speakers-symbolic`, containing one **Default Narrator**
   `AdwComboRow`. Register `narration-settings` and `default-narrator` as the
   GObject property/internal child. Populate its `GtkStringList` in
   `ViewPreferencesWindow` from Task 1’s formatted labels, then bind the data
   class to `selected` using the same bidirectional pattern as Default Font.
6. Run:
   ```sh
   FOLIATE_TEST_SCHEMA_XML=data/com.github.johnfactotum.Foliate.gschema.xml \
   nix-shell --run 'sh tests/run-isolated-tests.sh tests/view-preferences-test.mjs'
   ```

**Acceptance:** a reader can set the global narrator without a downloaded pack
or open book; the GSettings value is range-limited, persistent, and reflected in
the native Adwaita row.

## Task 4: Book-level selector, reset, and playback wiring

**Files:** modify `src/book-viewer.js`, `src/tts.js`, `src/voice-manager.js`,
`tests/voice-manager-test.mjs`, `tests/tts-controls-test.mjs`; add
`tests/narrator-settings-test.mjs`.

**Interfaces:**
- Consumes: Task 1 `NARRATORS`, `narratorLabel`, `resolveNarratorSid`; Task 3
  `NarrationSettings`.
- Produces: `TTSBox.setSupertonicSid(sid)`;
  `VoiceManagerDialog({ effectiveSid, storedSid, getGlobalSid })`,
  `VoiceManagerDialog.refreshNarrator(effectiveSid, storedSid)`, and the
  `narrator-selected` (`uint`) and `narrator-reset` signals.

1. Add failing Voice Manager regressions using its existing injected pack/job/
   player seams:
   - Supertonic shows a ten-choice Narrator group and starts on the supplied
     effective SID; Piper/Kokoro do not show it.
   - changing the combo and clicking **Preview** passes that SID to the player.
   - clicking **Use** after a real change emits `narrator-selected` with that SID
     **before** `voice-selected`. Record both signals in one list and assert the
     order; starting playback inside the pack handler must already see the new
     SID.
   - opening/using without changing the narrator does not create a book choice.
   - **Reset to Default Narrator** is in More Actions only for Supertonic. It is
     sensitive exactly when the book has a stored non-null SID, even when that
     SID equals the current global. Reset emits `narrator-reset`, moves the combo
     to the value returned by `getGlobalSid()` at click time, and clears any
     earlier unapplied combo change: select SID 7, press Reset, press **Use**,
     and assert `narrator-selected` does not fire and no book SID is written.
   - `getGlobalSid` is called at reset time, not captured in the constructor: a
     global change while the dialog is open is honored.
   - `refreshNarrator(effectiveSid, storedSid)` moves the combo to the new
     effective SID and updates stored state without emitting a signal; it does
     not overwrite a pending user change. Assert both: a refresh with no pending
     change moves the combo, and a refresh after selecting SID 7 keeps SID 7.
   - no user-visible string contains “override” or “inherited”.
2. In `VoiceManagerDialog`, add `effectiveSid = 0`, `storedSid = null`, and
   `getGlobalSid = () => 0` constructor inputs; add `narrator-selected`
   (`GObject.TYPE_UINT`) and `narrator-reset` signals plus
   `refreshNarrator(effectiveSid, storedSid)`. Reuse its current
   `Adw.PreferencesGroup`, `AdwComboRow`, Preview, Use, and More Actions
   implementation. Keep three separate pieces of state: the combo value, the
   book’s stored SID (`null` when the book follows default), and a `#pendingSid`
   set only by real user combo changes. When `#pendingSid` is set, **Use** emits
   `narrator-selected` then `voice-selected`; otherwise it emits only
   `voice-selected`. **Reset** sets `#pendingSid = null`, emits `narrator-reset`,
   and sets the combo to `getGlobalSid()`. Preview uses the combo SID only for
   Supertonic.
3. In `TTSBox`, accept optional `{ tts, player, daemonRunning }` constructor
   params for tests, defaulting to the current `new LocalTTS()` /
   `new LocalTTSPlayer({ tts })` / `() => getVoiceDaemon().running`.
   Add `setSupertonicSid(sid)` that stores `resolveNarratorSid({ stored: sid })`
   `.sid`. Store it as `#supertonicSid`. In `warm()`, key `#warmed` by
   `${pack.id}:${this.#supertonicSid}` and pass `sid` only when
   `pack.id === 'supertonic'`. In `#beginLocal`, pass
   `voice: this.#supertonicSid` to `playStream()` only for Supertonic. Never
   override Kokoro’s SID 23 or Piper’s SID 0. `setSupertonicSid` must not stop
   an active run; the new value applies to the next start. Existing
   `LocalTTSPlayer` already forwards its `voice` option to synth, so do not
   rewrite its queue.
4. Add failing `tts-controls-test.mjs` regressions with the injected fakes:
   - after `setSupertonicSid(9)`, a Supertonic `warm()` synth call receives
     `sid: 9`;
   - a Supertonic `playStream()` run's synth calls receive `sid: 9`;
   - after `setSupertonicSid(9)`, Kokoro and Piper synth calls receive no `sid`
     property at all (so their pack SID 23/0 still applies);
   - a second `warm()` after changing from SID 0 to 9 synthesizes again instead
     of being suppressed by the old pack-id gate.
5. In `BookViewer`, resolve `{ sid, followsDefault }` from
   `storage.get('tts-supertonic-sid', null)` and `NarrationSettings` through Task
   1’s resolver. Apply it with `tts.setSupertonicSid()` before `setPack()` and
   `warm()` on book ready. Pass `effectiveSid`, `storedSid`, and
   `getGlobalSid: () => narrationSettings.default` to Voice Manager. On
   `narrator-selected`, store the SID and call `tts.setSupertonicSid(sid)`; on
   `narrator-reset`, store `null` and call
   `tts.setSupertonicSid(getGlobalSid())`. Subscribe to
   `NarrationSettings` `notify::default`: while this book’s stored SID is
   `null`/absent, update `tts` and call
   `dialog.refreshNarrator(newSid, null)`. Do not change current pack
   persistence.
6. Add `tests/narrator-settings-test.mjs` (required, not optional). Cover
   `resolveNarratorSid` for absent, `null`, `0`, `7`, out-of-range, and
   non-integer input. Cover a real `JSONStorage` round-trip: absent → global 0;
   book `0` stays `0`; book `7` stays `7` after the global changes; reset writes
   `null` and then follows a new global `3`; reopening the JSON file preserves
   `null`. Keep the book-file format unchanged apart from the one nullable key.
7. Run:
   ```sh
   nix-shell --run 'sh tests/run-isolated-tests.sh tests/voice-manager-test.mjs tests/tts-controls-test.mjs tests/narrator-settings-test.mjs tests/voice-language-test.mjs'
   ```

**Acceptance:** selection is quiet and remembered for that book; reset follows
the current default; active default-following books update when Preferences
changes; previews, warm-up, cache, daemon, and direct CLI use the selected
Supertonic style; all other engines stay unchanged.

## Task 5: Whole-feature verification and human UX check

**Files:** no new implementation files unless a failing verification exposes a
minimal regression fix.

1. Inspect `git diff --check` and the changed-file diff for scope. Confirm no
   generated assets, model downloads, translation churn, test-harness broadening,
   or unrelated dirty files were changed.
2. Run all automated checks:
   ```sh
   make test
   nix-shell --run 'npx eslint src/voice-packs.js src/voice-daemon.js src/local-tts.js src/tts.js src/voice-manager.js src/book-viewer.js tests/voice-daemon-test.mjs tests/view-preferences-test.mjs tests/narrator-settings-test.mjs'
   ```
   Record pre-existing warnings separately from introduced errors. If voice
   assets and local engine exist, run the opt-in smoke/integration checks; report
   their exact skip reason otherwise.
3. In a disposable development profile, manually verify:
   - Preferences → Narration lists ten named/descrbed styles and changes default.
   - a book with no narrator starts with that default;
   - select/preview/use M5, reopen the book, and confirm M5 returns;
   - reset narrator, change global setting to F2, reopen, and confirm F2;
   - Piper/Kokoro still use their existing voices and do not expose Narrator;
   - with daemon running, F1 then M5 uses distinct `supertonic-<lang>-f1/m5`
     labels without daemon restart.
4. Request one free, read-only final review with this exact narrow brief:
   ```text
   Review only the Supertonic narrator diff against current dirty baseline.
   Check SID data flow from GSettings/book JSON to preview/warm-up/stream/daemon/CLI,
   reset semantics, GTK signal ordering, and leakage into Kokoro/Piper. Read tests
   and report only real findings as file:line severity problem fix. Do not edit,
   run git, claim commands you did not run, or propose unrelated refactors.
   ```
   Controller verifies every claim itself; a clean report is not a substitute for
   the commands above.

## Risks to review closely

- A book key of `0` must remain a real F1 selection, not look falsy and fall
  through to global settings.
- A reset must clear future book selection, not freeze today’s global SID into
  storage after a pack-only Use. Reset sensitivity therefore reads the stored
  book SID, never the effective/global comparison.
- The daemon has no request-level SID. Incorrect labels silently return F1, so
  exact label and TOML cardinality tests plus one real request-path assertion
  are required.
- Global narrator must never become an accidental SID override for Kokoro.
- `narrator-selected` must fire before `voice-selected`: the pack handler closes
  the dialog and may start playback immediately.
- The daemon config only registers `pack.languages`. Unsupported languages keep
  the existing CLI fallback, and that fallback must carry the selected SID.
- `GSETTINGS_BACKEND=memory` stores values but does not define schemas; the
  Preferences test must run with a compiled schema dir exported by the harness.
- A SID change must bypass the old pack-id-only warm-up gate, or the first Play
  after switching narrators uses the previous style.

## GSTACK REVIEW REPORT

| Review | Status | Notes |
| --- | --- | --- |
| UX/source research | complete | BookFusion, Thorium, Firefox, GNOME, Foliate reuse documented in `docs/research/2026-10-25-default-and-book-setting-ux.md`. KOReader excluded after source audit. |
| Free builder ambiguity review | complete | Storage, language, label, cache, and CLI seams mapped to current source; no product decision remains. |
| Free SID-routing review | complete | Daemon label round-trip, request-path label, daemon cache separation, mid-session SID application, and TTSBox SID tests added to Task 2/4. |
| Free narrator-state review | complete | Reset now keyed to stored SID; signal order fixed; Reset clears pending change; live global getter replaces constructor capture. |
| Free test-feasibility review | complete | Schema-dir harness support, required narrator-settings test, middle-index binding, and daemon request-path test added. |
| Paid Codex plan review | skipped by constraint | User requested free OpenRouter workers only. Task 5 requires an independent free read-only review instead. |

**Unresolved execution decision:** Current local-TTS baseline is uncommitted in
the primary checkout. Choose a safe isolated-copy strategy or explicitly approve
in-place implementation before source edits begin.
