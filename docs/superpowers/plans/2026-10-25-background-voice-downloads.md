# Background Voice Downloads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax. User explicitly requests `opencode/glm-5.3-flash-free` for subagents. Do not commit.

**Goal:** Let users dismiss the voice chooser and navigate Foliate while voice downloads/repairs continue.

**Architecture:** One app-process job manager owns transfer state/cancellation and mutation leases. Live chooser instances observe snapshots, detach on close, and restore the same operation on reopen. App exit cancels/awaits jobs before daemon shutdown.

**Tech Stack:** GJS, GTK4/libadwaita, Gio, existing libsoup pack APIs and isolated test launcher.

**Spec:** `docs/superpowers/specs/2026-10-25-background-voice-downloads-design.md`.

## Global Constraints

- Preserve every dirty checkout change. No commits, pushes, PRs, deployments, dependency installs, or real user model/settings/process changes.
- Every test process starts through `tests/run-isolated-tests.sh`; fresh canonical XDG roots and memory settings. Never use `/tmp/opencode/foliate-real-data/foliate`.
- CPU-only Kokoro/Supertonic/Piper and explicit Speech Dispatcher remain; no automatic voice selection after transfer.
- Existing `download`/`repairPack` APIs, pins, backups and rollback stay unchanged. Hold `prepareVoicePackChange() -> release()` across the entire transfer and release in finally after settlement.
- No queued downloads, resume-on-restart, daemon/service installs, toasts, or unrelated layout changes. At most one active transfer process-wide; same-job duplicate requests share it; other jobs fail without disrupting it.
- UI remains compact native Adwaita; raw errors stay wrapped/bounded. Dialogs unsubscribe on close and never get late widget updates.

## Review Focus

- Close during pending lease acquisition must neither cancel background work nor release the gate early.
- A second book/window must observe the active job, not create a duplicate or accidentally cancel someone else's work.
- Failed/cancelled repair must retain old bytes and release exactly once, including app shutdown.
- App shutdown must await cancellation/extraction cleanup before daemon shutdown without resurrecting widgets or auto-selecting.
- Resource-bundled builds must include all required voice modules, not only work from source.

### Task 1: Shared transfer owner and app teardown

**Files:** Create `src/voice-pack-jobs.js`, `tests/voice-pack-jobs-test.mjs`; modify `src/main.js`, `src/gresource.xml`.

**Interfaces:** Export `VoicePackJobs` class, `getVoicePackJobs()` singleton, `shutdownVoicePackJobs()` no-op if unused. Constructor accepts `{ download, repairPack, prepareVoicePackChange }` injected operations, falling back to production APIs. `get(id)` returns null or snapshot `{ packId, kind: 'download'|'repair', status: 'running'|'installed'|'failed'|'cancelled', progress: number|null, error: Error|null }`. Getter `active` returns running snapshot/null. `subscribe(listener)` invokes listener on changes and returns unsubscribe. `start(pack, kind = 'download') -> Promise<snapshot>` resolves terminal state (no unhandled transfer errors), shares duplicate same-job promise, rejects conflicting start. `cancel(id)` cancels only the matching active transfer. `shutdown() -> Promise<void>` prevents new starts, cancels and awaits owned transfer cleanup.

- [x] Add lifecycle/cancel/shutdown regressions; controller observed RED for terminal gate ordering and late progress.
- [x] Implement exact shared interfaces, plain snapshots, cancellable transfer operations and finally-based lease release.
- [x] Await jobs shutdown before daemon teardown; register required resource modules.
- [x] Focused tests and scoped lint pass; no commits.

### Task 2: Dismiss/reopen chooser integration

**Files:** Modify `src/voice-manager.js`, `tests/voice-manager-test.mjs` only.

**Interfaces:** Consume Task 1 API verbatim. Add constructor option `jobs`, default production singleton; tests explicitly inject a dedicated `VoicePackJobs` instance with fixture operations where needed. Dialog-local preview/readiness/removal stay separate from jobs. Existing signal contracts and per-book storage in `book-viewer.js` remain unchanged.

- [x] Native GTK regression observed RED before integration; tests now cover dismissal/parent navigation, progress/Cancel on reopen, multiple choosers, failure/retry, explicit cancel, repair during pending preparation, and explicit Use.
- [x] Replace obsolete close-cancels-transfer expectation while preserving settlement/removal/preview/readiness regressions.
- [x] Delegate download/confirmed repair to app jobs and unsubscribe on close; no late widget updates or auto-selection.
- [x] Scoped lint and full GTK tests pass. Native 360/520 screenshots reviewed, 218 px min content width; no overflow.

### Task 3: Controller integration gates

- [x] Controller finished after GLM quota exhaustion and inaccurate OpenRouter completion report; no more free-worker review loops. Fresh external review below.
- [x] Stable full `make test`, scoped ESLint (0 errors / 59 warnings), compiled resource inclusion check, native dismissal/navigation evidence.
- [x] Mandatory fresh code-only read-only Codex review: no findings.
- [x] Results and limits recorded in plan ledger; all changes uncommitted; actual Piper backup retained.

## GSTACK REVIEW REPORT

| Review | Runs | Status | Findings |
| --- | --- | --- | --- |
| Free GLM implementation | 1 | Incomplete: quota exhausted | Partial unverified source/tests retained and corrected by controller. |
| Free OpenRouter implementation | 1 | Report invalidated | Claimed UI/teardown edits absent; worker frozen before controller takeover. |
| Controller integration | 1 | Full suite/resources/diff checks pass | Native dismissal/reopen/navigation and lifecycle regressions pass; lint has 59 warnings, no errors. |
| External Codex, code-only read-only | 1 | Completed, exit 0 | No findings. Reviewer did not run tests; real extraction/rollback cancellation and installed packaged shutdown not covered by new supplied fixtures. |

**OUTSIDE COVERAGE:** `/tmp/opencode/voice-bg-codex-result.md`; actual full suite evidence `/tmp/opencode/voice-bg-final-make-test.log`. GResource compiled, but installed-app shutdown E2E not separately run. Existing pack API rollback/cancel fixtures remain in full suite.
**VERDICT:** background transfers implemented and verified; no commits or deployment. Narration still observes existing exclusive mutation gate; reading/navigation works after dismissing chooser.
NO UNRESOLVED DECISIONS
