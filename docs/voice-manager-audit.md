# Voice chooser and narration-state audit

Date: 2026-10-24. Scope: the Choose Voice dialog, narration controls, pack
download/validation/removal, preview playback, saved selection, and daemon lifecycle.

## Outcome

The overflow is a confirmed error-layout bug, not a screen-size problem.
Piper also has a separate, confirmed integrity problem: its installed model and
tokens are empty, and the app accepts empty files as an installed voice. The UI
and backend do not share a sufficiently complete account of voice availability.

No production code was changed during this audit. No installed voice was
deleted, repaired, downloaded, synthesized, or overwritten. Existing worktree
changes were preserved. Experiments wrote only disposable scratch artifacts.

## Evidence and limits

- Reviewed the user's `make run` output: the daemon disconnected and aborted at
  23:04:58; the floating sheet repeatedly requested 3502 px at 1122/2560 px
  available. Tracker and WebKit warnings precede those failures; header-callback
  warnings occur separately during shutdown.
- Read `voice-manager.js`, `voice-packs.js`, `voice-daemon.js`, `local-tts.js`,
  `local-tts-player.js`, `tts.js`, their integration in `book-viewer.js` and
  `navbar.js`, UI templates, settings, and voice-related tests. Also checked the
  daemon's registry, configuration validation, and native model-loading boundary.
- Ran a real GTK layout probe at 1122 px and 420 px. A 236-character synthetic
  diagnostic raised the dialog's minimum width from 271 px to 1176 px and
  reproduced `AdwFloatingSheet ... exceeds AdwBreakpointBin width`.
- Ran isolated GTK state probes with an HTTP 503 fixture and injected synthesis
  failure. They reproduced the lost friendly error, multiple suggested actions,
  empty-file acceptance, and enabled selection/removal during preview loading.
- Inspected the actual Piper model files read-only. Their contents are empty;
  this is not an inference from a network error.
- Did not intentionally crash a native engine, mutate real packs, or rerun the
  whole suite. A failed first scratch probe had a missing microtask yield; the
  corrected probe completed successfully.
- Keyboard traversal, assistive-technology output, large font settings, and
  light appearance still need explicit checks. This report does not claim a
  complete accessibility certification.

Artifacts:

- `/tmp/opencode/voice-page-layout-audit.mjs`
- `/tmp/opencode/voice-page-layout-audit/{idle,engine-error,narrow-idle}.png`
- `/tmp/opencode/voice-page-state-audit.mjs`
- `/tmp/opencode/piper-integrity-audit.md` (bounded read-only helper report)

## Findings

### F1 — P1 bug: error text sets the dialog's minimum width

`src/voice-manager.js:53,109-118,126-129,156-158`

The same `Gtk.ProgressBar` displays transfer status and arbitrary engine errors.
With `show_text: true`, its diagnostic text is single-line and contributes its
full width to the minimum size request. `content_width: 520` is a preferred
width, not a hard limit. Disabling horizontal scrolling does not fix the child
widget's minimum size.

Measured with the real dialog: idle minimum 271 px; error bar minimum 1140 px;
dialog minimum 1176 px. The user's longer diagnostic requested 3502 px.

Fix the content contract: keep progress text short, put a short actionable error
in a wrapping label, and put technical details in a bounded, wrapping disclosure.
Do not conceal the problem by clipping the whole sheet.

### F2 — P1 bug: an empty model is reported as installed

`src/voice-packs.js:101-114`; `tests/voice-packs-test.mjs:84-95`

`verifyDirectory` checks only file/directory types. A zero-byte ONNX model and a
zero-byte token file pass. The tests explicitly create empty required files and
expect verification to succeed.

Actual files:

| Path under `~/.local/share/foliate/voices/piper/` | Bytes |
| --- | ---: |
| `en_US-amy-low.onnx` | 0 |
| `tokens.txt` | 0 |
| `en_US-amy-low.onnx.json` | 4164 |

Both empty files have birth/mtime `2026-10-24 18:45:17.666556609 -0500` and the
empty-file SHA256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.

At minimum reject empty required files before enabling preview/use or including
a pack in daemon configuration. A nonempty file is not proof of a valid model;
installation integrity and backend readiness need separate states. Preserve
legacy valid downloads rather than forcing every user to download them again.

### F3 — P1 risk: native model failure can terminate all daemon voices

`foliate-voice/crates/foliate-voice/src/engine.rs:26-42`;
`foliate-voice/crates/foliate-voice/src/config.rs:529-536`;
`src/voice-daemon.js:155-168`; `src/local-tts.js:198-216,265-266`

The engine wrapper documents that corrupt models can make sherpa/ONNX exit or
allow a foreign exception to cross the Rust boundary. File-readability checks
do not reject empty or malformed model contents. The user's log confirms a
native abort; it does not identify which voice request triggered it.

After a daemon failure, the client retries the same request through the CLI,
which can fail on the same invalid pack. Its full stderr becomes the dialog
error in F1. Daemon stdout, including structured model-load context, is silenced.

Reject known-invalid packs before native loading, distinguish model failure from
transport failure, and retain diagnostic context. Do not claim that a Rust panic
handler can catch a foreign native exception.

### F4 — P1 bug: availability changes do not update daemon configuration

`src/voice-daemon.js:123-149,196-210`;
`src/voice-manager.js:100-107,149-155`; `src/book-viewer.js:890-900`

The daemon snapshots installed packs once at startup. Download and removal do
not refresh it. A newly installed voice can be selected immediately but be
unknown to the running daemon, producing a failure and CLI fallback. An already
loaded, removed voice can remain represented in the daemon until restart.

Make install/remove invalidate the daemon's pack snapshot. Coordinate that
transition with playback cancellation, and make readiness explicit before use.

### F5 — P1 bug: removal changes selection before removal succeeds

`src/voice-manager.js:149-158`; `src/book-viewer.js:896-900`

`voice-removed` is emitted before `deletePack` runs. The caller clears the
current voice and saved book selection before knowing whether deletion worked.
A permission/I/O failure leaves files installed but selection already cleared.

Only publish removal after it succeeds. Wait for operations using the pack to
settle before changing its files. This ordering issue is verified from source;
an actual permission-failure deletion was not performed on user data.

### F6 — P2 bug: download failure loses its friendly message

`src/voice-manager.js:86-87,109-118`

The catch block sets a helpful subtitle, but `finally -> #refresh` immediately
replaces it with the size/language metadata. A real fixture HTTP 503 reproduced
the final subtitle `1 MB · en`, while the raw URL/error remained in the progress
bar. A failure needs a persistent row state, not a temporary widget assignment.

### F7 — P2 bug: visual emphasis does not mean selection

`src/voice-manager.js:64-66,77-88`

With no saved selection and English as the language, all three catalog entries
can receive `suggested-action`: two match English and the third is also the
default. The GTK probe reproduced three suggested buttons simultaneously.
There is no separate selected/current indicator, and the selected pack still
has the same `Use Voice` action as every other installed pack.

Use one explicit selection, distinct from recommendation and installation state.

### F8 — P2 risk: preview is a partial busy state with no Stop action

`src/voice-manager.js:81-85,90-93,122-138,149-154`

The probe confirmed that preview loading disables preview buttons but leaves
Use Voice and Remove enabled. The user cannot stop preview except by closing
the dialog or taking a different action. Changing/removing a voice calls stop
without awaiting completion before subsequent state/file operations.

Allow an explicit Stop action and define which transitions cancel and await the
active operation. This is a verified control-state mismatch, not a claim that
every click sequence has reproduced a native crash.

### F9 — P2 UX issue: metadata and repeated actions crowd out the task

`src/voice-manager.js:30-55,86-87`

Three suffix buttons per installed row compete with the voice name. Supertonic
lists 31 raw language codes, plus a language count in its title, plus Installed
in the subtitle. At 420 px the language list and name consume several lines;
the three actions still occupy the same horizontal strip.

Use short, human-readable language summaries and one selection affordance.
Preview and removal do not need to be repeated as equally prominent controls
on every row. Keep native Adwaita styling and keyboard affordances.

### F10 — P2 bug: a hidden setting still affects system narration

`src/ui/tts-box.ui:20-69`; `src/tts.js:75-77,88-90`;
`src/book-viewer.js:718-720`

Read footnotes is inside local-only controls, but its value is supplied to the
reader's TTS initialization for either backend. Switching to Speech Dispatcher
hides a content-selection setting that still takes effect. Put shared content
options outside backend-specific controls.

## State coverage

| Transition/state | Evidence | Result |
| --- | --- | --- |
| Idle chooser at 1122/420 px | Rendered GTK measurements and screenshots | Fits while no error is shown; narrow rows are crowded |
| Long preview/synthesis error | Rendered diagnostic injection | Reproduced off-screen expansion |
| Download failure/retry | Local HTTP 503 fixture | Retry enabled; friendly error overwritten |
| Empty required files | Actual Piper files and isolated fixture | Incorrectly accepted as installed |
| Missing/invalid pack repair | Source trace | No repair action; download refuses an existing directory |
| Selected/recommended state | Isolated GTK fixture | Three suggested actions with no saved selection |
| Preview loading/failure | Injected synthesis promise/error | Other state-changing actions remain enabled |
| Successful download | Existing test review, not rerun | Auto-selects; daemon snapshot is not refreshed |
| Cancel/close during download | Source and existing test review | Cancellation/staging cleanup exists; no inline Cancel |
| Remove success/failure | Source trace | Notification precedes deletion |
| Backend switch | Source trace | Shared footnote setting disappears |
| Daemon abort | User log and native wrapper | Fatal boundary established; specific request unrecorded |

## Test-data safety finding

`/tmp/opencode/foliate-real-data/foliate` is a symlink to
`/home/hugh/.local/share/foliate`, not an independent model tree. Earlier
references to it as isolated data were inaccurate; isolated cache/config
directories do not isolate these model files. Do not write fixtures through it.

The writer that emptied Piper is not established. Scratch
`/tmp/opencode/dialog-repro.mjs:10-15` contains an empty-file fixture loop, but its
presence and nearby timestamp do not prove it wrote the real files. Do not
present that inference as a confirmed cause. No automatic deletion/redownload
was attempted during this audit.

## Other log messages

- Tracker typelib missing: library lookup warning, not evidence for the width
  request or Piper corruption. Do not install a dependency without the user's
  instruction on this NixOS machine.
- Deprecated WebKit hyperlink auditing: unrelated deprecation warning.
- Shutdown `ListBoxUpdateHeaderFunc`: a separate lifecycle warning. The source
  has a JS header function at `src/library.js:808-825`; the log alone does not
  identify the exact originating list. Do not attribute it to the chooser without
  a reproducer.

## What to preserve

- Native Adwaita widgets, semantic theme colors, and responsive sheet behavior.
- CPU-only local synthesis and the explicit Speech Dispatcher option.
- Pinned archive checksums, streaming downloads, and staged atomic installation.
- Existing per-book choice and user-downloaded models that are valid.
- Persistent narration pause/resume/stop/speed controls outside the popover.

## Recommended simplification — proposal, not yet implemented

Keep the compact native chooser rather than creating another settings page.
Give each voice one selectable row with a concise language summary and explicit
availability. Use one Preview/Stop control, contextual Download/Cancel/Repair,
and a secondary menu for Remove and technical details. Display one selected
voice, not multiple suggested buttons. Keep errors wrapped and separate from
transfer progress. Shared narration options remain visible across backends.

Use explicit states such as not installed, downloading, verifying, ready,
previewing, and failed. Installation, backend readiness, and user selection are
related but are not interchangeable. Destructive repair must be explicit and
must preserve the old directory until the replacement is validated.

A minimal text-wrapping patch would fix F1 but leave the state and integrity
failures. A new full settings page adds navigation without solving those
failures. The compact chooser plus lifecycle fixes is the recommended scope.

## Verification required for the fix

1. Regress empty files, truncated/changed data, failed installation, and safe
   repair without destroying the existing pack on a failed replacement.
2. Regress idle/error minimum width at narrow, normal, and large-text sizes.
3. Cover the dialog's error, retry, cancel, preview/stop, select, remove-failure,
   and close-during-operation transitions with injected boundaries.
4. Cover installing/removing a pack while the daemon is already running.
5. Exercise genuine Piper loading/synthesis using validated data and fresh,
   canonical-path-checked test directories; do not use the real-data symlink as
   a writable fixture tree.
6. Check keyboard focus, accessible names/state, and both appearances. Recheck
   rendered results after simplification; layout-only tests are not enough.

## Outcome (2026-10-25, controller)

All ten findings plus the compact-chooser redesign are implemented and verified on the working tree (`feat/local-read-aloud`, uncommitted). Coverage: F1/F6–F9 chooser fixes with native-widget and rendered audits; F2 pack integrity via staged repair with retained backups and pinned checksum/Layout validation; F3/F4/F10 readiness/lease/daemon separation with isolated CLI probes; F5 close/cancel races covered by chooser regressions.

Evidence: full `make test` rc=0, ESLint 0 errors; genuine Piper scratch download/readiness/daemon synthesis PASS (109100-byte WAV, isolated roots); rendered audit min-width 215–254 px across 360/420/520/1122 px incl. long errors, dark mode and 1.25x scaled text with no overflow warnings; independent review SPEC/QUALITY PASS and corrected code-only Codex review completed (7 findings triaged: 6 fixed, 1 plan-mandated fallback documented).

Remaining limits: real-app GUI E2E was not separately automated (full keyboard traversal was not screenshot-audited); Supertonic word substitution, the recounted currency bug, and FST remain unchanged.

Installed Piper recovery was separately authorized and completed on 2026-10-25 through one pinned-source `repairPack` operation. Model: 63,104,657 bytes; tokens: 763 bytes; isolated readiness PASS; daemon synthesis produced a 105,410-byte WAV (3.2926875 s), then the owned daemon stopped. The original tree is retained at `~/.local/share/foliate/voices/piper.backup-047c916c-1cd2-4ecf-ba93-bb88546bcda6`, verified against its original file hashes/metadata. Other voice trees' metadata was unchanged. Evidence: `/tmp/opencode/voice-page-authorized-piper-nzekghss/`.

Restart instructions: restart the app normally (no reinstall or binary deployment needed; app modules run from this checkout and the already-deployed foliate-voice binary is current).

## Background download follow-up (2026-10-25)

User requested non-blocking app navigation and selected app-owned background downloads. Download and confirmed-repair jobs now survive chooser dismissal; reopening in the same or another book/window restores progress, errors/retry and explicit Cancel. Closing still stops local previews/readiness work. Transfer completion never auto-selects a voice; explicit Use remains required. App exit cancels and awaits transfer cleanup before daemon shutdown. Existing mutation lease still covers the whole transfer, so narration can remain unavailable during it; ordinary reading/navigation works after dismissal.

Verified: full `make test` exit 0; scoped ESLint 0 errors / 59 warnings; compiled resource includes jobs/gate/validation; native dismissal restores parent focus while job runs; 360/520 screenshots reviewed (218 px min width, no overflow); fresh code-only read-only Codex review found no defects. Installed packaged shutdown E2E remains untested. Everything remains uncommitted. Evidence and rulings: `.superpowers/sdd/2026-10-25-background-voice-downloads/progress.md`.
