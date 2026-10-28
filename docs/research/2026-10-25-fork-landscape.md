# Foliate upstream and fork landscape

Date: 2026-10-25
Status: research note; no source, git config, issue, or remote changes made.

## Scope and method

- Upstream determined from `git remote -v`: `origin` is
  <https://github.com/johnfactotum/foliate.git>, default branch `gtk4`.
- Local branch under study: `feat/local-read-aloud`, with the worktree also
  carrying uncommitted voice-download work.
- Sources: GitHub REST API through `gh`, first-party repository pages, commit
  metadata, PRs, issues, and the local `src/foliate-js` submodule. All activity
  figures are a snapshot from 2026-10-25 and can move.
- This note deliberately separates the app repository from the
  `johnfactotum/foliate-js` dependency, because most TTS rendering work lives
  there and must be contributed separately.

## Upstream state

| Signal | Value |
| --- | --- |
| Repository | <https://github.com/johnfactotum/foliate> |
| Default branch | `gtk4` |
| Stars / forks | 8,846 / 434 |
| Open PRs / issues | 35 / 304 |
| Last app commit | 2026-04-08, `67b6676` "Add CONTRIBUTING.md guidelines (#1658)" |
| Last release | `3.3.0`, 2025-04-01 |
| Latest app tag | `3.3.0` (no 3.4 or later) |

Evidence: <https://github.com/johnfactotum/foliate/commits/gtk4>,
<https://github.com/johnfactotum/foliate/releases>.

The app repository has been effectively dormant for about six months while its
issue tracker stays active. Recent issues receive comments and reproductions
through 2026-10-23, but the recent PRs sampled here have no maintainer review.
The maintainer's last visible app commit is the April CONTRIBUTING change; the
dependency's last visible commit is `78914ae` in `foliate-js` on 2026-05-01.

This matters for contribution strategy: a technically good PR can still sit
unreviewed. Small, independently valuable changes are more likely to survive a
long review queue than a feature branch.

### Release polish gaps

- `CONTRIBUTING.md` explicitly asks for one change per PR:
  <https://github.com/johnfactotum/foliate/blob/gtk4/CONTRIBUTING.md>.
- Flatpak still targets GNOME runtime 49, which is end-of-life:
  <https://github.com/johnfactotum/foliate/blob/gtk4/com.github.johnfactotum.Foliate.json>.
  PR #1727 proposes 51 with an 11-line diff:
  <https://github.com/johnfactotum/foliate/pull/1727>.
- Version metadata disagrees: `meson.build` says `3.3.0`, `package.json` still
  says `3.1.1`, and `debian/changelog` calls `3.3.0` a 2023 release.
  <https://github.com/johnfactotum/foliate/blob/gtk4/meson.build>,
  <https://github.com/johnfactotum/foliate/blob/gtk4/package.json>.
- ESLint runs with `continue-on-error: true`, so lint never gates a merge, and
  the workflow still uses `actions/checkout@v3` and
  `github/codeql-action/upload-sarif@v2`:
  <https://github.com/johnfactotum/foliate/blob/gtk4/.github/workflows/eslint.yml>.
- The app has no test suite. The only CI is lint, Debian packaging, and Snap
  packaging. This makes every behavioural PR depend on manual testing.

### Stale `foliate-js` pin

The app pins `src/foliate-js` at `399248a` (2026-03-05), three commits behind
`main` (`78914ae`, 2026-05-01). The missing commits include the external-link
fix and a TTS fix:

- <https://github.com/johnfactotum/foliate-js/commit/78914ae>
- <https://github.com/johnfactotum/foliate-js/commit/5ba02c7>

This is the root of app issue #1733 ("external links have query args stripped"):
the fix exists upstream in `foliate-js`, but the app has not consumed it.
<https://github.com/johnfactotum/foliate/issues/1733>

A naive submodule bump is not enough. `foliate-js` `78914ae` changed the
`external-link` event payload from `href` to `href_`, while
`src/book-viewer.js` still expects `href`. The regression is documented in
`foliate-js` PR #163 and its review thread:
<https://github.com/johnfactotum/foliate-js/pull/163>.
The clean sequence is: land #163 (or adapt the app to `href_`), then bump the
submodule.

## Active and recently updated forks

| Fork | Activity evidence | Work | Relevance | Confidence |
| --- | --- | --- | --- | --- |
| [MoncefDrew/foliate](https://github.com/MoncefDrew/foliate) | 4 commits ahead of `gtk4`; last push 2026-10-15 | PR #1674: Google Translate TTS, rebuilt `tts-box.ui`, live volume/speed, plus PDF/progress/stats/library changes | Directly comparable to local TTS work; cautionary example of an unreviewable diff | High |
| [4rdii/foliate](https://github.com/4rdii/foliate) | Two app branches, last push 2026-04-11; `foliate-js` PR #127 | PR #1660 finishes the commented-out TTS voice dropdown (4 files, +43/−3); PR #1661 adds a persistent navbar play/pause button (3 files, +27/−0) | Best existing model for small, reviewable TTS PRs; also fixes PDF TTS crashes in `foliate-js` | High |
| [djinnalexio/foliate](https://github.com/djinnalexio/foliate) | Seven branches; last push 2026-10-21; five open app PRs | #1727 runtime 51; #1728 library shortcut; #1729 Preferences rename; #1730 keyword/translation update; #1736 page-specific help | Active generalist contributor; #1730 shows how translation churn can swamp a code change (44 files, +15,443/−8,517) | High |
| [Arimfexendrapus/foliate](https://github.com/Arimfexendrapus/foliate) | Six branches; last push 2026-10-18; four open PRs | #1723 WebKit chapter-zoom workaround; #1724 app color scheme; #1725 library color switch; #1726 remember zoom | Active bug-fix cluster around #1671, #1699, #1722, #1732, #1735; #1723 received cross-contributor review and was revised | High |
| [lynking03/foliate](https://github.com/lynking03/foliate) | Two commits; last push 2026-10-22 | PR #1740 font-weight override, 5 files, +93/−22 | Small, tested feature; overlaps DreamMaoMao's fork and the long-running font-weight complaints in #1462 | High |
| [carluma/foliate](https://github.com/carluma/foliate) | Branch `spanish-wiktionary`, last push 2026-10-23 | One commit adding Spanish Wiktionary support; issue #1738 opened 2026-10-21 | Fresh, narrow localization work; not yet a PR | High |
| [asugan/foliate](https://github.com/asugan/foliate) | Two commits; last push 2026-10-11 | Turkish defaults, Turkish Wiktionary rewrite, selection shortcuts, rebuild notes | Shows localization forks diverging into hard-coded per-language rewrites; argues for a configurable Wiktionary base instead | Medium |
| [DreamMaoMao/foliate](https://github.com/DreamMaoMao/foliate) | 52 commits ahead; last push 2026-10-14 | Font weight, remember zoom, Ctrl+wheel zoom, J/K navigation, edge-reveal header/sidebar, word count, theme tweaks | Personal UX fork; proves demand for features already in open PRs (#1723–#1726, #1740), but not upstreamable as a series | High |
| [lucag/foliate](https://github.com/lucag/foliate) | One commit; last push 2026-10-25 | Adds `CLAUDE.md` and `docs/agents/{domain,issue-tracker,triage-labels}.md` | Agent-navigation docs, not a product change; weak upstream relevance | Medium |
| [chimes-of-freedom/foliate](https://github.com/chimes-of-freedom/foliate) | Last push 2026-10-16 | PR #1731 corrects four reversed Simplified Chinese serif/sans labels | Tiny translation fix; useful evidence for low-risk review work | High |
| [rbienvenu0/foliate](https://github.com/rbienvenu0/foliate) | Last push 2026-09-02 | PR #1715, two-line fix for `<pre>` blocks hidden across pages | Tiny, targeted fix for #1624 | High |
| [jurijcerar/foliate](https://github.com/jurijcerar/foliate) | Last push 2026-07-17 | PR #1696, 21-line image-viewer scroll/pinch zoom | Old but small; addresses #366 | Medium |

Other recent forks are either straight mirrors (pushed at the same timestamp as
upstream), translation-only branches, or packaging forks such as
`Cracksoldier/foliate-win`. They do not add reviewable product work beyond what
is listed above.

## What is interesting

### 1. TTS is the biggest unmet area, and the biggest diff trap

The local branch is a full local neural TTS subsystem: voice catalog, download
and verification, daemon, player, normalization, DOM stripping, UI, and tests.
The committed branch alone is 40 files and +5,255/−30 versus `gtk4`; the
worktree adds another 28 modified/untracked paths.

The closest upstream attempt, PR #1674, is worse as a review unit: 139 files,
+2,694/−376, and it mixes Google Translate TTS with PDF reading, progress
tracking, stats, and library redesign. It has no reviews or comments and has
been open since 2026-05-12. The head commit is "fix : pdf errors and zoom",
which is unrelated to TTS. <https://github.com/johnfactotum/foliate/pull/1674>

This is strong evidence that a single "TTS rework" PR will not be reviewed. It
also conflicts with the maintainer's stated direction in #841: prefer the
SpeechSynthesis API with speech-dispatcher underneath, avoid arbitrary commands
for sandbox/security reasons, and send paragraph-sized SSML with marks rather
than page-sized text. <https://github.com/johnfactotum/foliate/issues/841>

By contrast, PR #1660 and #1661 are the shape upstream can review: 3–4 files,
27–46 changed lines, explicit design notes, and a test plan. They are still unmerged,
which says more about maintainer bandwidth than about their quality.
<https://github.com/johnfactotum/foliate/pull/1660>,
<https://github.com/johnfactotum/foliate/pull/1661>.

### 2. The local `foliate-js` work is the most upstreamable piece

The local submodule contains four commits, 456 insertions across four files:

- `dom-stripper.js`: 404 new lines
- `text-walker.js`: offset handling
- `tts.js`: SSML block-boundary and skip-set handling
- `view.js`: read-notes option

These commits sit on `399248a` (the app's pin), not on `foliate-js` `main`
`78914ae`, so they need a rebase. They directly address two long-standing
upstream problems:

- issue #78, ruby annotations read aloud:
  <https://github.com/johnfactotum/foliate-js/issues/78>
- the maintainer's complaint in #841 that TTS uses `Range.toString()` per page
  instead of paragraph/block-aware SSML.

`foliate-js` is more active than the app: 31 open PRs and 38 open issues, with
new PRs in the last week. <https://github.com/johnfactotum/foliate-js/pulls>.
This is the best place to establish a contribution record.

One overlap to resolve first: local commit `ea2b368` includes a
`Intl.Segmenter` null fix, and `foliate-js` PR #127 already proposes the same
fix for PDFs. <https://github.com/johnfactotum/foliate-js/pull/127>. Rebase and
drop or explicitly credit the duplicate.

### 3. Small app-side fixes already have ready-made patterns

The active forks show a healthy supply of small patches but a review bottleneck:

- #1719 `<ctrl>c` does not copy the selection; the popover Copy button works.
  No PR exists. This is a contained action-routing bug and a good first fix.
  <https://github.com/johnfactotum/foliate/issues/1719>
- #1734 dictionary/Wikipedia popup text is white-on-white or black-on-dark-gray.
  No PR exists. It is CSS/theme work, not a rendering rewrite.
  <https://github.com/johnfactotum/foliate/issues/1734>
- #1703 "Override Publisher Font" does not override publisher line height.
  No PR exists; PR #1740 is adjacent but only covers font weight.
  <https://github.com/johnfactotum/foliate/issues/1703>
- #1573 TTS starts from the wrong position. The local branch's block snapshot
  and `lastLocation.range` start path is a plausible fix, but it needs the
  reporter's EPUB to verify. <https://github.com/johnfactotum/foliate/issues/1573>
- #1733 is already fixed in `foliate-js`; it needs a submodule bump, not new
  app code. See the stale-pin section above.

### 4. Duplicate work is visible across forks

`DreamMaoMao` has 52 commits implementing font weight, remembered zoom,
Ctrl+wheel zoom, and shortcut changes. `lynking03` independently submitted font
weight as PR #1740; `Arimfexendrapus` independently submitted remembered zoom as
PR #1726. Both are five-file or smaller changes.

This is not a reason to build another variant. It is a reason to review, test,
or co-author the existing PRs. For a new contributor, landing someone else's
small fix is often a faster path to trust than adding a fourteenth branch.

## Candidate upstream contributions

Ranked by reviewability and fit with upstream direction:

1. `foliate-js`: DOM-aware narration extraction, split into two PRs:
   a. `dom-stripper.js` plus text-walker offset fix and tests;
   b. SSML block-boundary/skip-set/read-notes changes.
   Rebase onto `78914ae`, resolve overlap with PR #127, and link issue #78.
2. App: a small SSIP-path PR that consumes the landed `foliate-js` extraction
   and adds the read-footnotes preference. No new engine, no downloads, no new
   native dependency. This is the upstream-compatible part of the local work.
3. App: one isolated bug fix with a regression test, preferably #1719
   (`<ctrl>c`) or #1573 (TTS start position). Keep it under ten files.
4. Release polish: separate PRs for Flatpak runtime 51 (#1727), lint gating and
   action-version updates, and version-string alignment. Do not mix them with
   feature work.
5. Submodule hygiene: land `foliate-js` #163, then bump `src/foliate-js` to
   `main` and fix the `external-link` contract in `book-viewer.js`; this closes
   #1733 and unblocks future `foliate-js` fixes.

## Recommendations

1. **Start in `foliate-js`, not the app.** Rebase the four local submodule
   commits onto `78914ae`, drop the duplicate `Intl.Segmenter` fix if PR #127
   covers it, and open two focused PRs. This is the highest-confidence
   contribution because it matches an explicit maintainer request in #841 and
   an open issue (#78), and the dependency repo is still active.
2. **Do not open the 5,255-line local branch as one PR.** Use PR #1674 as the
   counterexample: 139 files, mixed concerns, zero review since May. Split the
   work into (a) `foliate-js` extraction, (b) app SSIP integration and
   read-footnotes, (c) a separate design issue for the local neural engine.
3. **Keep the first app PR under ten files and add tests.** Model it on #1660
   and #1661, not on the local integration commit. The best candidates are the
   TTS start-position bug (#1573) or the Ctrl+C regression (#1719). Include a
   reproducible test or a manual test plan with exact steps.
4. **Treat release polish as a separate track.** Three tiny PRs: Flatpak
   runtime 51 (#1727), make ESLint actually gate plus update actions, and align
   `meson.build`/`package.json`/`debian/changelog`. These are low-risk and
   demonstrate maintenance discipline without competing with feature review.
5. **Coordinate before duplicating.** Review or test #1740 (font weight),
   #1723–#1726 (zoom/theme), #1731 (zh_CN labels), and carluma's Spanish
   Wiktionary branch before writing another variant. If the maintainer remains
   inactive, propose a maintained fork or a `foliate-js`-first release path
   rather than accumulating unreviewed app branches.

## Confidence and limits

- Upstream counts, dates, and PR sizes: high confidence, read directly from the
  GitHub API on 2026-10-25.
- Fork activity: high confidence for the listed forks; the full 434-fork set
  was sampled by recency and stars, not exhaustively diffed.
- Maintainer intent: medium confidence. #841 is from 2022–2023 and the
  maintainer has not commented on TTS since; the direction is the best written
  signal available, not a current commitment.
- The local branch's ability to fix #1573 is unverified; the reporter's EPUB is
  private and no reproduction was run for this note.
- The `foliate-js` #163 / submodule-bump interaction is based on the PR review
  thread and commit metadata, not on a local build with `main`.
- No source code, git config, issues, or remote repositories were changed.
