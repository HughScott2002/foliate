# Liquid AI models for local Foliate narration

Date: 2026-10-27
Status: research note; no production source, git config, dependency, or model
download was changed.

## Decision in one line

Treat **LFM3-Audio-2B** as an optional, benchmark-first high-quality narration
engine; use **LFM3-VL-2B** only for an opt-in, background-cached description of
meaningful uncaptioned images; do **not** put a generative text model in the
meaning-preserving normalization path.

## What Foliate already has

The local narration worktree is already designed around the right experience:
one-time local voice download, sentence and word read-along, continuous
look-ahead synthesis, page turns only at safe section boundaries, WAV caching,
and no network use after a pack is installed.

- `src/tts-normalize.js` is a deliberately conservative, language-aware rules
  normalizer. It exposes one stable `normalizeText(text, lang)` seam, with a
  reserved compiled-FST backend.
- `src/tts.js` normalizes each sentence before it reaches the engine; its player
  synthesizes several sentences ahead, so narration does not pause at paragraph
  boundaries.
- Current packs are small, purpose-built TTS models: Piper (64 MB, English),
  Kokoro (141 MB, English/Chinese), and Supertonic 3 (123 MB, 31 languages).
  Supertonic supplies ten installed narrator styles, including five feminine and
  five masculine presets.
- The existing packaged runtime is `sherpa-onnx-offline-tts` 1.13.8. It cannot
  run Liquid's LFM3 audio or vision models; a Liquid engine needs a separate
  runner and model lifecycle.

Therefore the strongest product principle remains: **text extraction, sentence
identity, highlighting, and audio playback are stable; a model is a replaceable
producer of audio or optional annotations.**

## Liquid AI snapshot

### LFM3-Audio-2B — relevant TTS candidate

Liquid's current 2B audio model accepts text or 16 kHz audio and produces text,
24 kHz speech, or both. It documents TTS in 18 languages/locales: Arabic,
Danish, German, Greek, British/American English, Finnish, French, Hebrew,
Italian, Japanese, Korean, Dutch, Polish, Portuguese, Spanish, Swedish,
Turkish, and Chinese. TTS control is deliberately small: language/locale and a
`female` or `male` voice. Its codec can stream generated audio frames.

Liquid reports a 3.83 English UTMOSv2 score, above its LFM2.5-Audio baseline
(3.22) and the listed Qwen2.5-Omni 3B comparator (3.42). This is useful evidence
that the new model deserves a listening test, but it is not evidence that it is
better than Foliate's Kokoro or Supertonic packs: neither appears in that table,
and long-form audiobook continuity is not measured.

The current official GGUF files show the cost of a truly local install:

| Component | Smallest listed practical GGUF set | Download size |
| --- | --- | ---: |
| Audio runner weights | `LFM3-Audio-2B-Q4_0.gguf` | 1,049,613,856 bytes |
| Audio multimodal projector | `mmproj-LFM3-Audio-2B-Q8_0.gguf` | 337,862,080 bytes |
| **Minimum downloaded model files** | Q4 model + required projector | **1,387,475,936 bytes (~1.39 GB)** |

That is about ten times the current 141 MB largest voice pack, before runtime
memory and audio cache. It is not an acceptable default download for a desktop
book reader, but it can be a clearly labelled "High-quality experimental" voice
pack for people who choose it.

The official model documentation currently says GGUF support is coming soon,
while Liquid's own official Hugging Face GGUF repository contains the files
above. This is a very new release surface; pin an exact model revision and test
the runner before making product promises.

### LFM3-VL-2B — strong fit for image descriptions

LFM3-VL-2B is a 1.92B image/video-language model. It can caption images, read
documents, and reason about visual content; it supports sixteen text languages.
The local Q4_K_M weight plus required Q8 projector is about 1.30 GB
(1,099,627,808 + 203,031,872 bytes). It is much too large to load in the
read-aloud hot path, but its work is naturally cacheable: an image's bytes and
model revision are immutable for a given EPUB.

LFM3-VL-2B, not LFM3-Omni, is the right model for this narrow job. Omni bundles
vision, audio understanding, TTS, tool calling, and voice-chat features Foliate
does not want. A smaller responsibility gives a simpler permission story: no
microphone access, no conversation history, no tools, and no model action beyond
one local image-to-text request.

### LFM3-1.7B — useful, but not as a runtime normalizer

The current text model has 1.73B parameters, a 256K context window, and a Q4
GGUF around 1.10 GB. It supports the languages needed for many books and can
produce structured outputs. Its natural use is classification or offline
development assistance—not rewriting every narrated sentence.

No instruction prompt can prove a generative model preserved meaning. It can
silently change a name, number, unit, quotation, citation, or fictional wording.
For a reader, a rare confident error is worse than an unchanged awkward phrase.

## Recommended product shape

### 1. World-class local narration: benchmark Liquid as a fourth engine

Keep Supertonic 3 as the broad default. Add LFM3-Audio only if a blind listening
test proves it improves the experience for its 18 supported locales.

The engine contract should remain exact-text in, PCM/WAV out:

1. Foliate extracts and normalizes one sentence.
2. The engine receives that exact final string with a fixed locale and chosen
   voice category.
3. It streams 24 kHz frames into the existing buffered player, while a complete
   WAV is cached under text, engine revision, locale, voice, and generation
   settings.
4. Existing sentence marks remain the source of truth for highlighting. Audio
   generation never changes what range is highlighted.

This preserves the strongest part of the existing implementation: uninterrupted
read-along works independently of which local model makes the sound.

Required acceptance bar before offering it:

- Blind A/B listening against all ten Supertonic presets and Kokoro, with prose,
  dialogue, numbers, URLs, citations, poetry, and long chapters in each supported
  locale.
- Measure first audio, real-time factor, underruns, RAM, CPU, battery, and
  audible continuity across at least 30 minutes.
- Check exact textual fidelity by comparing the input sentence with the
  synthesized speech using human review; ASR alone is not enough.
- Prove that stop, pause, resume, cache corruption, and an engine crash cannot
  lose the reader's place or leave narration wedged.

Do not market it as "world class" until it wins this test. Liquid's published
benchmark is promising, not sufficient proof for literary narration.

### 2. Image-aware read-along: calm, factual, and never on critical path

The immersive version is not "describe every image." It is an opt-in
**Describe meaningful images** setting with these rules:

1. Prefer author/publisher `alt`, `aria-label`, and a nearby figure caption. Do
   not generate a duplicate description when accessible text already exists.
2. Consider only images Foliate currently treats as skippable figures/images
   that lack usable text.
3. Generate in a background queue when a chapter opens, never while audio waits.
   Cache output by EPUB image hash, language, model revision, and prompt version.
4. Read it once, at the image's DOM position, with a neutral spoken marker such
   as "Illustration:". Cap it at one factual sentence and a small word budget.
5. Prompt for visible facts only: no plot inference, character names absent from
   nearby text, emotional interpretation, or invented text. If the model is
   unsure, emit no description.
6. Let a reader disable descriptions for one book without disabling narration.

This provides value for illustrated novels, cookbooks, graphic nonfiction, and
technical books without turning the reader into a chat product. VLMs can still
hallucinate; the explicit marker and opt-in setting preserve trust.

### 3. Meaning-preserving input cleaning: deterministic first

The current `rules` normalizer already handles safe fixes such as soft hyphens,
ligatures, line-wrap hyphens, whitespace, and a limited English set of
abbreviations and symbols. Its planned compiled-FST backend is the correct next
step for comprehensive text normalization.

If Liquid helps, use LFM3-1.7B only behind a **no-rewrite gate**:

- It may classify a sentence as ordinary prose, a date/number, an abbreviation,
  a citation, code, a URL, or another known pattern.
- Foliate then applies a deterministic, language-specific renderer only for
  patterns it supports; otherwise it sends the original text unchanged.
- It never emits replacement prose and is never required for playback.

Even this classifier is likely a poor trade for a 1.10 GB download. A better
first use is an offline developer tool that finds normalization edge cases and
suggests new FST/rule tests. Shipping an LLM to rewrite book text conflicts with
the "do not change meaning" requirement.

## Explicit non-goals

- No microphone permission, speech input, voice chat, agent loop, tool calling,
  external service, account, or book conversation.
- No cloud fallback. Every chosen model runs entirely on the user's machine
  after the user downloads it.
- No automatic replacement of the small existing voice packs.
- No generated text inserted into the EPUB or reading position; optional image
  descriptions are ephemeral annotations with their own cache.

## Rollout order

1. **Audio spike:** pin a Liquid revision; make a disposable local runner; run
   the listening, latency, memory, and failure tests. Do not add UI or ship a
   model download yet.
2. **Decide audio:** retain it only if it wins clearly for a useful locale set;
   then design it as an optional engine with its own size, license, RAM, and
   experimental-status disclosure.
3. **Vision spike:** on a small consented EPUB corpus, compare publisher
   alt/captions, LFM3-VL descriptions, and human review. Measure false detail,
   duplicate narration, and chapter-open cost.
4. **Text:** improve deterministic rules/FSTs from failures observed in the
   audio test. Revisit a local classifier only if there is a measured class of
   errors rules cannot address.

## Licensing and distribution

LFM3 models use the LFM Open License v1.0, not Apache-2.0 or MIT. Commercial use
is free only for legal entities below US$10M annual revenue; entities at or over
that threshold need a separate Liquid license. Distributing model files also
requires the license, notices, and modification marking. Foliate should obtain a
project-level licensing decision before hosting or bundling these weights.

## Primary sources

- [Liquid LFM3-Audio-2B documentation—capabilities, languages, 24 kHz output, streaming, TTS controls, and runtime](https://docs.liquid.ai/lfm/models/lfm3-audio-2b)
- [Official LFM3-Audio model card—published quality table and streaming details](https://huggingface.co/LiquidAI/LFM3-Audio-2B)
- [Official LFM3-Audio GGUF repository—exact file names, sizes, and revision](https://huggingface.co/api/models/LiquidAI/LFM3-Audio-2B-GGUF?blobs=true)
- [Liquid LFM3-VL-2B documentation—vision capability, languages, and local formats](https://docs.liquid.ai/lfm/models/lfm3-vl-2b)
- [Official LFM3-VL GGUF repository—exact file names, sizes, and revision](https://huggingface.co/api/models/LiquidAI/LFM3-VL-2B-GGUF?blobs=true)
- [Liquid LFM3-1.7B documentation—purpose, languages, context, and memory claim](https://docs.liquid.ai/lfm/models/lfm3-1.7b)
- [Official LFM3 text GGUF repository—exact file names, sizes, and revision](https://huggingface.co/api/models/LiquidAI/LFM3-1.7B-GGUF?blobs=true)
- [Liquid LFM Open License user guide](https://docs.liquid.ai/lfm/help/model-license)

Local implementation inspected: `src/tts.js`, `src/tts-normalize.js`,
`src/local-tts.js`, `src/local-tts-player.js`, `src/voice-packs.js`, `shell.nix`,
and `com.github.johnfactotum.Foliate.json`.
