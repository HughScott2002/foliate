# Aloud versus Foliate local narration

Date: 2026-11-01
Status: source audit; no listening test or implementation change.
Compared: Foliate branch `feat/narration-follow-return` at `df93643` and
[Aloud](https://github.com/smailoujaoura/aloud) at `4ea183e`.

## Finding

Aloud does not introduce a fourth voice-model family. Both projects support
Supertonic 3, Kokoro, and Piper. Aloud's practical advantages are a larger voice
catalogue, model-derived word timing for Piper and Kokoro, and a clock-scheduled
audio queue. Whether any Aloud voice *sounds* better than Foliate's selected
voice requires a blind listening comparison; the source alone cannot establish
that.

| Area | Foliate fork | Aloud | Consequence |
| --- | --- | --- | --- |
| Voice choice | One exposed Kokoro SID (`23`), one Piper `en_US-amy-low` pack, ten Supertonic styles | Multiple Kokoro and Piper voices and ten Supertonic styles | Voice selection is the cheapest plausible route to a preferred sound. |
| Model/runtime | Sherpa ONNX through a local daemon; Supertonic int8 pack is about 123 MB | ONNX Runtime Web in browser workers; Supertonic full-precision download is about 402 MB | Larger weights and GPU support may change speed or sound, but neither proves superior audio quality. |
| Highlight | Local playback emits a sentence mark and highlights its DOM range | Sentence plus moving word; Piper and Kokoro use model phoneme durations mapped to page words | Foliate lacks word timing, not just a second CSS style. |
| Supertonic word timing | Sentence marks only | Word positions estimated from audio length and text | Aloud's Supertonic word marker can drift; it is not model-exact. |
| Audio handoff | Synthesizes ahead, then starts a GStreamer WAV session after the previous session completes | Schedules audio buffers at accumulated times on one Web Audio clock | Aloud can join prepared sentences without a per-session handoff gap. |
| Navigation | Manual page turns do not move narration; Return to narration finds the current spoken sentence | Manual scrolling suspends following; a control returns to the spoken sentence | Foliate already implements the requested separation for EPUB page turns. |
| Start position | Selection start snaps to the beginning of its word | Right-click Read from here is supported, but has an open positioning bug | Do not replace Foliate's exact-word start with Aloud's current locator. |

Foliate source: [`src/voice-packs.js`](../../src/voice-packs.js),
[`src/voice-daemon.js`](../../src/voice-daemon.js),
[`src/local-tts-player.js`](../../src/local-tts-player.js),
[`src/reader/tts.js`](../../src/reader/tts.js),
[`src/reader/reader.js`](../../src/reader/reader.js), and
[`src/foliate-js/tts.js`](../../src/foliate-js/tts.js).

Aloud source: [engine catalogue](https://github.com/smailoujaoura/aloud/blob/4ea183e/src/shared/engine-catalog.ts),
[default voice choices](https://github.com/smailoujaoura/aloud/blob/4ea183e/src/shared/settings.ts),
[word timing](https://github.com/smailoujaoura/aloud/blob/4ea183e/src/engine/g2p/word-timing.ts),
[estimated timing](https://github.com/smailoujaoura/aloud/blob/4ea183e/src/audio/estimate-words.ts),
[audio scheduler](https://github.com/smailoujaoura/aloud/blob/4ea183e/src/audio/scheduler.ts),
[following behavior](https://github.com/smailoujaoura/aloud/blob/4ea183e/src/content/session.ts), and
[reported start-position bug](https://github.com/smailoujaoura/aloud/issues/4).

## Smallest useful next steps

1. Listen blind to Foliate's existing ten Supertonic styles and Kokoro voice
   alongside the Aloud voices that sound better to the reader. Note the exact
   model and voice, rather than assuming the engine is better.
2. If the preferred voice is already present in Foliate's installed model,
   expose its selection. If it is a different Piper voice, add that voice as an
   optional pack. Keep the current pack choices intact.
3. Treat word highlighting as a separate feature. Aloud reads phoneme timing
   from its Piper and Kokoro runtime; Foliate's daemon currently returns a
   whole WAV and duration, so its interface would need timing data or a
   deliberately approximate fallback before a word marker could stay in sync.
4. Consider clock-scheduled playback only if measured gaps remain after
   synthesis lookahead. It is a larger player change than voice selection.

## Evidence limits

This is a code and documentation audit, not a playback benchmark. No voice
samples were compared by listening, and no Aloud extension was installed or
tested here. Aloud's Firefox listing was new at the time of this audit and had
no reviews. Agent Reach was used for repository research. Its X search found
insufficient public content, then its X backend failed because it was not
installed; there are no X user reports supporting the quality comparison.
