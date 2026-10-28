# Background voice downloads

## Intent and agreed approach

User wants voice downloads not to block navigation and chose **Background download**: close the chooser without cancelling; reopen it to see progress/errors or cancel; completion still needs explicit Use. User requested execution with free GLM subagents, then said `keep going`.

## Design

Keep the native compact chooser. Move download/repair transfer state into one app-process job manager; dialogs subscribe while open and unsubscribe on close. Starting a transfer does not force the chooser open, and the normal close button/Escape lets the user return to reading/navigation. Show concise guidance during transfers that closing keeps the download running. Opening the chooser in another book/window sees the same job and cannot start a duplicate/conflicting transfer.

Jobs retain terminal errors and installed/cancelled results while Foliate runs. Cancel explicitly stops the transfer, awaits extraction/rollback, then releases the mutation gate. Use/preview/remove remain dialog-local, and the per-book choice changes only after explicit successful Use. Closing the chooser still stops previews and cancels dialog-local readiness/removal work. Confirmed repairs use the same background lifecycle and retained-backup safeguards as downloads.

Controller call: exiting Foliate cancels and awaits active jobs before daemon shutdown; no background service, restart-resume, queue, notification system, or persistent job storage. Keep the existing exclusive mutation gate across the entire download/repair, including network and publication/rollback; narration may remain unavailable during it, but normal app navigation must work. Narrowing that gate is separate work.

## Alternatives

- **Chosen:** app-owned background jobs, dismiss/reopen existing chooser. Preserves native UI and avoids extra windows; requires a small shared state module.
- Separate non-modal voice window: permits navigation while showing progress but adds window management and departs from the compact chooser. Not selected.

## Constraints and proof

Preserve dirty changes, pinned downloads, CPU-only backends, safe staging/backup/rollback, and explicit voice selection. No commits, deployment, installs, real-data tests, or unrelated refactors. New tests use the existing external XDG isolation launcher and loopback fixtures. Regress dismiss/reopen mid-transfer, explicit cancel, failure/retry persistence, two choosers sharing one job, close-before-lease races, shutdown cleanup, and navigation becoming interactive after dismissal.
