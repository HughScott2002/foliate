# Voice Page Reliability Implementation Plan

> **For agentic workers:** Use subagent-driven-development. Controller owns scope, contracts, and integration decisions; DeepSeek V4.1 Flash owns code and execution. Steps use checkboxes for tracking.

**Goal:** Fix all ten findings in the approved voice-page audit and simplify the native chooser.

**Architecture:** Keep native GTK/Adwaita. Separate installed-file integrity, backend readiness, selection, and active operation. Reject invalid packs before native loading; validate existing models through an isolated CLI probe, not the shared daemon. Give the chooser one selection and contextual actions, backed by safe install/repair/remove transitions.

**Tech Stack:** GJS, GTK4/libadwaita, Gio/libsoup, existing CPU-only sherpa CLI and foliate-voice daemon; NixOS.

**Spec:** `docs/voice-manager-audit.md`, approved by the user's request to fix them all. Existing WAV continuity changes remain intact.

## Global Constraints

- CPU-only local synthesis; preserve Kokoro, Supertonic, Piper, explicit Speech Dispatcher, book selection, and persistent playback controls.
- Preserve all pre-existing changes. No commits, pushes, PRs, binary deployment, new system tools, dependency installation, or unrelated refactors.
- Workers must not mutate real model files, real settings, or existing user processes. Never use `/tmp/opencode/foliate-real-data/foliate` as a writable fixture: it symlinks to real user data.
- Each writable test tree must be newly created and checked to resolve inside its scratch root before fixture writes. Test-data repair uses fixtures only; actual Piper recovery needs a separately scoped user confirmation.
- Use existing checkout/feature branch for this continuation; no reset, stash, or copying/discarding the dirty worktree.
- Keep raw diagnostics out of single-line progress controls. Preserve technical evidence behind bounded details/logs.
- One task per worker, no nested agents. Return DONE/PARTIAL/BLOCKED with evidence; no self-assigned follow-up. Scope changes and substantive ambiguity return to controller.
- User approved parallel work up to five agents. Tasks 1–3 have disjoint write ownership; full-suite/runtime verification waits until all are stable.

## Review Focus

- Empty/malformed/changed models must not be treated as ready or repeatedly loaded in the shared daemon (Tasks 1–2).
- Repair cancellation/failure must preserve the prior directory and selection (Tasks 1, 3).
- Download/remove while daemon is running must not leave a stale voice catalog or act on in-use files (Tasks 2–3).
- Long errors, narrow windows, large text, and localized metadata must not inflate minimum width (Task 3).
- Close/cancel/select/remove during async operations must settle once, without stale UI updates or premature selection changes (Tasks 2–3).

## Ownership and shared interfaces

1. Pack integrity: `src/voice-packs.js`; `tests/voice-packs-test.mjs`, `tests/voice-packs-download-test.mjs`, `tests/voice-language-test.mjs`.
2. Backend lifecycle: `src/voice-daemon.js`, `src/local-tts.js`, `src/local-tts-player.js`, new `src/voice-pack-validation.js` (and a small guard module if needed), `src/tts.js`, `src/ui/tts-box.ui`, necessary `src/book-viewer.js` integration, `Makefile` test isolation; corresponding local-TTS/controls/integration tests and new validator/daemon tests. Do not touch Task 1 or 3 files.
3. Chooser: `src/voice-manager.js`, `tests/voice-manager-test.mjs`, optional new chooser-only tests. Do not touch Task 1 or 2 files.
4. Final integration/review: frozen patch, audit document, targeted fixes assigned back to their owners.

Exact cross-task contracts:

- Task 1 exports `getPackState(pack) -> { status: 'missing' | 'invalid' | 'installed', message: string | null }`, cheap synchronous metadata validation, rejecting empty required files. `installed` is not a claim of backend readiness.
- Keep `verifyPack(pack) -> boolean`, `download(pack, onProgress = null, cancellable = null) -> Promise`, `deletePack(id)` and catalog APIs compatible. Add `repairPack(pack, onProgress = null, cancellable = null) -> Promise` for explicitly requested, staged replacement with a retained unique backup. Do not overwrite a healthy directory via ordinary download.
- Task 2 exports `ensurePackReady(pack, { cancellable = null } = {}) -> Promise<void>` from `src/voice-pack-validation.js`. Use structural state plus an isolated CLI validation/synthesis probe, never shared-daemon probing of untrusted model data. Cache successful probes by required-file identity/change metadata; changes/repair invalidate the result. Reject known-invalid model errors with `error.code === 'invalid-pack'`; missing engine/transport is not proof of corruption.
- Task 2 exports `prepareVoicePackChange() -> Promise<release: () => void>` from `src/voice-daemon.js`: acquire an exclusive mutation gate before model file mutation, block new native readers/lazy startup, settle existing CLI/probe readers and this app's daemon, and refuse mutation if settlement fails. Gate covers publication and rollback, not only daemon shutdown. Caller MUST call release in finally; prepare failure releases its own gate. Later synthesis lazily starts/reconciles a fresh current-pack configuration. No global process killing or nested-read-lease deadlocks.
- Task 2 adds `LocalTTSPlayer.stopAndWait() -> Promise<void>`: stop its own run and await teardown; existing synchronous `stop()` remains available.
- Task 3 keeps `voice-selected(pack)` and `voice-removed(id)` signals. Selection emits only after readiness succeeds and explicit Use action. Removal emits only after successful deletion. Failed actions preserve selection.
- Chooser may inject its player/operations for deterministic tests, with production defaults. This is a narrow test seam, not a generic service framework.

## Task 1: Pack integrity and safe repair

Brief: `/tmp/opencode/voice-page-task-1.md`.

- [x] Add RED tests: zero-byte required files rejected; missing versus invalid distinguished; cancelled/failed repair preserves old bytes; successful repair retains backup and publishes validated staging; ordinary download refuses existing directory.
- [x] Implement shared interfaces above, preserving current pinned archive checksums and staging safeguards. Bound repair to the specified pack; rollback failed publication without deleting the old backup.
- [x] Replace owned empty-file test stubs with nonempty fixtures; keep tests asserting safety, not accepting corrupt packs.
- [x] Run owned pack/download/language tests through `nix-shell`; report RED/GREEN evidence, changed files, and exact commands. Do not run full suite while peers work.

Implementation returned with targeted suites green; final spec/quality and publication-failure coverage review remain Task 4 gates. Evidence: `/tmp/opencode/voice-page-task-1-report.md`.

## Task 2: Readiness and backend/playback state

Brief: `/tmp/opencode/voice-page-task-2.md`.

- [x] Add RED tests for isolated failed probe preventing shared-daemon use; validation cancellation/changed-file invalidation; no repeated invalid-model fallback; daemon refresh after pack changes; removal waits for settlement; shared footnote setting survives backend switch visibly.
- [x] Implement validation/readiness APIs. Reuse CLI argv/protocol, drain diagnostics, clean only owned probe artifacts, and never probe an untrusted model in the shared daemon. Do not invent an ONNX parser or attempt to catch foreign C++ exceptions with Rust panic handling.
- [x] Reconcile lazy daemon startup/catalog after install/removal; distinguish invalid-pack errors from transport errors. Preserve CPU use, cancellation, existing WAV cache policy, and working CLI fallback for genuine availability/transport failures.
- [x] Implement awaited playback teardown and move shared footnote UI outside backend-only controls. Preserve selected-book state if a mutation fails.
- [x] Harden `make test`: set fresh canonical-checked XDG_DATA_HOME/XDG_CACHE_HOME/XDG_CONFIG_HOME before each GJS process starts, use memory settings, and disable real-model smoke in normal unit runs. In-process setenv alone is insufficient because GLib caches these paths.
- [x] Run owned targeted tests and lint changed source; report commands and evidence. Request controller decision instead of changing cross-task contracts or daemon Rust code.

Implementation returned with targeted suites green and one genuine Piper download/readiness/daemon synthesis PASS in isolated scratch data (`/tmp/opencode/voice-page-real-piper-backend-report.md`; first attempt failed only from a floating-promise scratch runner). Fix wave: readiness fingerprint now includes ctime/usec/inode/device so same-size/same-mtime replacement re-probes (RED→GREEN regressions); test runner disables Mesa shader caches and preserves the real test rc on bounded cleanup. Final full-suite/rendered/app gates remain Task 4. Evidence: `/tmp/opencode/voice-page-task-2-report.md`.

## Task 3: Compact chooser and explicit operation states

Brief: `/tmp/opencode/voice-page-task-3.md`.

- [x] Add RED GTK tests for long error minimum width, one selected item, persistent friendly failure/retry state, explicit Use after download, preview Stop/cancel, close during operations, and no removal signal on deletion failure.
- [x] Keep a compact Adwaita dialog. Show concise voice/language descriptions, one selected row, one Preview/Stop control, and one contextual primary Use/Download/Cancel/Repair action. Move Remove/details into a secondary menu/disclosure. Do not remove necessary functions or the explicit system backend option elsewhere.
- [x] Use separate wrapped error content and bounded technical details, never raw diagnostics in progress text. Check fit at 360/420/520/1122 px and scaled text; use native sizing rather than clipping.
- [x] Use Task 1/2 APIs; await preview settlement and acquire mutation lease before repair/remove; release it in finally after publication/rollback; confirm destructive actions within the UI. Emit state-change signals only after success. Closing cancels owned work and blocks late widget updates.
- [x] Update existing download test to expect installed/candidate state followed by explicit Use, rather than auto-closing on download.
- [ ] Capture representative rendered screenshots and run chooser-only tests/lint. Chooser-only tests passed (eight targeted plus repair-failure/retry/close); final rendered capture at fixed widths and the lint pass are owned by the Task 4 verification gate now running.

Implementation: original worker stopped before any edits; replacement owner found the compact chooser present, then added the first-download mutation lease, preview teardown, close-state reset, and repair tests 3b/3c/3d, and fixed premature `ready=true` after repair. Evidence: `/tmp/opencode/voice-page-task-3-implementation-report.md`; scoped fix diff `/tmp/opencode/voice-page-task-3-fix-review-diff.txt`.

## Task 4: Frozen-patch review and verification

- [x] Freeze worker edits; collect one diff package including untracked new source/tests and baseline continuity changes.
- [x] Fresh review for spec and quality; mandatory Codex review because this change touches more than five files. No repeated reviews without concrete changed findings.
- [x] Run complete `make test` and ESLint once on stable code. Confirm all ten audit findings have regression coverage or explicit, evidenced resolution.
- [x] Validate genuine model behavior only with fresh, canonical-path-checked scratch model data. Keep user models read-only. Do not claim actual installed Piper repaired unless a later separately authorized recovery is performed.
- [x] Review rendered chooser at narrow/normal sizes, long error/details, dark/light and scaled text; check keyboard and shared backend options.
- [x] Update audit with outcomes/remaining limits and provide concise restart instructions. Do not deploy a binary or commit unless separately requested.

Controller execution note: the final gates ran directly by the controller after the user cancelled delegation, so two runs of `make test`/ESLint (pre- and post-fix) plus the rendered audit cover this section. Keyboard coverage: initial focus lands on the first selectable row (verified in every audit window); full traversal/key-focus screenshots were not separately captured. E2E against a running app instance was not separately automated; widget-level native tests and the rendered audit exercise the same states.

## Pre-flight/self-review

| Pair/task | Shared contract | Ruling |
| --- | --- | --- |
| 1 ↔ 2 | installed metadata vs backend readiness | Separate states; Task 2 probes only when necessary and keys cache to file changes. |
| 1 ↔ 3 | repair/download and missing/invalid status | Stable exports above; GUI confirms repair, backend preserves old data. |
| 2 ↔ 3 | prepare mutation, stopAndWait, readiness | GUI awaits these; no duplicate daemon-management logic. |
| 1 self | existing fixture tests | Nonempty stub files required; do not rewrite peers' fixtures. |
| 2 self | safe probe vs daemon validation | Probe subprocess owns native failures; never publish readiness from mere existence. |
| 3 self | simplicity vs feature preservation | Contextual controls replace repeated controls, not capabilities. |
| 4 self | tests vs writable real-data symlink | New guarded data roots only; installed Piper remains a separate recovery gate. |

Coverage: F1/F6–F9 → Task 3; F2/repair → Task 1; F3/F4/F10 → Task 2; F5 → Tasks 2–3. No scope gap intentionally deferred. Actual model recovery is gated by user-data safety, not dropped.

User explicitly requested implementation by delegated workers now; no additional plan-approval round. Codex plan consultation precedes implementation, and controller settles any reported contract issue.

## GSTACK REVIEW REPORT

| Review | Runs | Status | Findings |
| --- | --- | --- | --- |
| External Codex plan consultation | 1 | Completed; two risks addressed in plan | Expanded mutation gate to all native readers through rollback; pre-process XDG isolation and smoke disabled in normal tests. |
| Independent frozen combined review | 1 | Completed before fix wave 2 | SPEC PASS / QUALITY PASS; external attempt 1 invalid (workspace-write, nested invocation, timeout) was excluded; readiness staleness flagged. |
| Corrected external code-only Codex | 1 | Completed rc=0 (read-only sandbox, stdin input, no orchestration briefs) | 7 findings: 4 chooser bugs, 1 lease-ordering risk, 1 nested-fingerprint risk, 1 plan-mandated fallback (not a bug). |
| Controller fix wave B | 1 | Targeted suites + full suite + lint green after fixes | Findings 1–5 and 7 fixed with regressions; finding 6 ruled plan-mandated and documented. |

**OUTSIDE COVERAGE:** corrected `codex exec -s read-only` code-only review completed (`/tmp/opencode/voice-page-codex-code-only-result.md`, input at `/tmp/opencode/voice-page-codex-run/`). First combined external attempt was invalid and did not count.
**VERDICT:** all reported blocking/risk findings fixed or explicitly ruled (plan-mandated fallback); direct controller verification green; implementation complete. Installed Piper recovery was subsequently authorized and passed on 2026-10-25; retained backup and evidence are recorded in `docs/voice-manager-audit.md`.
NO UNRESOLVED DECISIONS
