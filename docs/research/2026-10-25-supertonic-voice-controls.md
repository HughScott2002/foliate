# Supertonic voice, style, and expression controls

Date: 2026-10-25

## Finding

**Yes—Supertonic 3 has ten runtime-selectable preset voice *styles*.** The
official web example presents `M1`–`M5` and `F1`–`F5`; selecting one loads its
corresponding `voice_styles/<name>.json` embedding. It is a selected style
embedding, not a free-form `speaker`, `emotion`, `pitch`, or `style` scalar.
One non-batch synthesis takes one style; batch synthesis can pair a different
style with each text.

Supertonic 3 also advertises ten inline expression tags. The official archive
names only `<laugh>`, `<breath>`, and `<sigh>` as examples; it does not publish
the complete tag vocabulary or an emotion-strength parameter. Do not invent
the other seven names. There is no documented runtime `emotion`, `speaker`,
`pitch`, temperature, or seed control in the official ONNX example.

## Model-family versions are not style choices

| Family checkpoint | Languages | Expression tags | Meaning |
| --- | ---: | --- | --- |
| Supertonic 1 | 1 (`en`) | — | Earlier model family |
| Supertonic 2 | 5 | — | Different multilingual checkpoint |
| Supertonic 3 | 31 | 10 inline tags | Current Foliate pack's model family |

Choosing Supertonic 1/2/3 changes model assets and capabilities. It is not a
runtime choice among voices. Within Supertonic 3, the ten style embeddings are
the voice-choice mechanism. The open-weight local package is described as
fixed-voice; historical custom-style creation used Voice Builder rather than a
local reference-audio inference API. The official archive says that service
ceased after 2026-08-31.

## Official ONNX controls

| Control | Default / values in official example | Voice relevance |
| --- | --- | --- |
| `--voice-style` | Path(s), default `voice_styles/M1.json`; released presets `M1`–`M5`, `F1`–`F5` | **Selects voice style** |
| `--lang` | One language per text; Supertonic 3 supports 31 codes, plus `na` in the repository example | Language, not speaker/style |
| `--speed` | `1.05`; docs recommend `0.9`–`1.5` | Speaking-rate control |
| `--total-step` | `8` | Denoising quality/latency tradeoff, not expression |
| inline tags in text | Ten advertised; public examples include `<laugh>`, `<breath>`, `<sigh>` | Discrete expressive events, not a general emotion dial |
| `--batch` | One style/text/language tuple per batch item | Different preset per item; no documented mid-utterance speaker switch |

`--n-test`, `--onnx-dir`, `--save-dir`, and `--use-gpu` are also listed by the
example, but do not control voice or expression. Repeated inference samples
noise internally, yet the example exposes no seed or variation parameter.

## Foliate's current `supertonic` pack

Foliate pins the int8 Supertonic 3 sherpa-onnx release asset, labels it
"Supertonic 3 (31 languages)", and configures `voice.bin` with `sid: 0`.
It forwards `--lang`; its one-shot command can receive a `--sid`, but no
current narration call supplies a voice selection. The daemon generates one
voice table per language, all with the pack's `sid: 0`, and its request body
contains only the language-specific voice label. Therefore **the shipped UI
currently exposes neither preset voice selection nor expression/emotion
controls**.

The pack is more capable than that UI: inspection of the exact pinned release
asset's `voice.bin` found header dimensions `10, 50, 256, 10, 8, 16`. Its ten
vectors exactly match the official Supertonic 3 release JSONs in this SID
order:

| SID | Official preset |
| ---: | --- |
| 0–4 | `F1`, `F2`, `F3`, `F4`, `F5` |
| 5–9 | `M1`, `M2`, `M3`, `M4`, `M5` |

Thus Foliate already downloads every released preset and defaults to `F1`.
It could expose voice choice without a new model download, but needs a
persisted preset/SID selection and daemon voice entries (or a request-level
SID) for all ten values. The existing daemon path otherwise pins all requests
to SID 0. Expression tags would need an intentional text-authoring/injection
policy and UI; they are not an independent runtime control.

## Primary sources

- [Official archived Supertonic repository—features, 31-language `lang="na"`, expression-tag examples, model-family table, and Voice Builder sunset](https://github.com/supertone-oss-archive/supertonic/blob/main/README.md)
- [Official Supertonic 3 model card at its archived revision—released `voice_styles/` assets and fixed-preset/local custom-style scope](https://huggingface.co/supertone-oss-archive/supertonic-3/blob/aafc6e32416a594460b32413efc49d7fe4ce6d46/README.md)
- [Official browser inference example—ten selectable preset files](https://github.com/supertone-oss-archive/supertonic/blob/main/web/index.html)
- [Official Python ONNX inference guide—exact CLI controls, defaults, batch pairing, and rate range](https://github.com/supertone-oss-archive/supertonic/blob/main/py/README.md)
- [Official Python ONNX example—style embeddings passed to synthesis and no emotion/seed parameter](https://github.com/supertone-oss-archive/supertonic/blob/main/py/example_onnx.py)
- [Foliate-pinned Supertonic 3 int8 release asset](https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2)

Local configuration inspected: `src/voice-packs.js`, `src/local-tts.js`,
`src/local-tts-player.js`, `src/tts.js`, and `src/voice-daemon.js`. No source,
git configuration, issue, or remote repository was changed.
