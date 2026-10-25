// Text normalization for the TTS front end: the last thing the reader's
// text passes through before it becomes speech. Its job is to fix what
// makes an engine (neural or speech-dispatcher) misread a book — soft
// hyphens, ligatures, abbreviations, symbols — so nothing malformed
// reaches the model.
//
// This module is a STABLE INTERFACE, not an implementation choice. Callers
// only ever call normalizeText(text, lang). The backend behind it can be
// swapped without changing a single caller:
//
//   'rules' (default) — the conservative built-in ruleset below
//   'none'            — identity; something downstream normalizes instead
//                       (this is what a compiled normalizer run by the
//                        engine — e.g. a NeMo/WeTextProcessing grammar
//                        compiled to an OpenFst FST — would select, so the
//                        two never both run and double-normalize)
//   'fst'             — reserved for that compiled-FST backend; behaves as
//                       'none' here until the FST is wired in (the FST is
//                       matched by the engine, not by JavaScript)
//
// The built-in rules are deliberately conservative and English-first: a
// wrong expansion is worse than none. They are NOT a complete text
// normalizer — that is exactly what the 'fst' backend is for.

// Ligature characters that should be spoken as their letters.
const LIGATURES = {
    '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi',
    '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st',
}

// Abbreviations read out in full. Keyed exactly; only matched as whole
// tokens (word boundary before, whitespace/punctuation/end after).
const ABBREVIATIONS = {
    'Dr.': 'Doctor', 'Mr.': 'Mister', 'Mrs.': 'Missus', 'Ms.': 'Miss',
    'Prof.': 'Professor', 'St.': 'Saint', 'Jr.': 'Junior', 'Sr.': 'Senior',
    'etc.': 'et cetera', 'e.g.': 'for example', 'i.e.': 'that is',
    'vs.': 'versus', 'Fig.': 'Figure',
    'approx.': 'approximately', 'Dept.': 'Department',
}

// "No." is only a number when a digit follows; on its own it is the word
// "no" and must not become "Number".
const NUMBER_ABBR = /\bNo\.(?=\s*\d)/g

// Symbols the engine would otherwise read as their glyph name or skip.
const SYMBOLS = [
    [/&/g, ' and '],
    [/\u00A7/g, ' section '],
    [/\+/g, ' plus '],
    [/=/g, ' equals '],
    [/\u2026/g, '...'],
    [/[\u2014\u2013]/g, ', '],
]

const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Language-neutral cleanups, safe for any script: invisible break hints,
// wrapped-word hyphenation, ligatures, and stray whitespace.
const cleanUniversal = text => {
    let s = text
    s = s.replace(/\u00AD/g, '')                    // soft hyphen
    s = s.replace(/(\p{L})-\n(\p{L})/gu, '$1$2')    // hyphen at a line break
    for (const [lig, letters] of Object.entries(LIGATURES))
        s = s.split(lig).join(letters)
    return s
}

// A whole sentence in CAPS (a shouted heading such as the book's
// "SHOULD YOU SELL YOUR COMPANY?") makes neural engines over-pronounce or
// misread it (Supertonic renders all-caps differently from title case).
// Fold it to sentence case. Only when EVERY letter is uppercase, so inline
// acronyms in normal prose (CEO, FBI) are never touched; scripts without
// case (CJK) and letter-free strings are left alone. CAVEAT: an acronym
// inside an all-caps sentence is lowercased too (we cannot tell it apart);
// the FST backend will handle acronyms properly later.
const foldAllCaps = text => {
    const letters = text.replace(/[^\p{L}]/gu, '')
    if (letters.length < 2) return text
    if (letters !== letters.toUpperCase()) return text   // some lowercase present
    if (letters === letters.toLowerCase()) return text    // no case (CJK, etc.)
    const lower = text.toLowerCase()
    return lower.replace(/\p{L}/u, c => c.toUpperCase())  // first letter back up
}

// English-specific rewrites (symbols, currency/percent, abbreviations).
// NOTE: currency/percent are position-fragile on purpose ("$5 million"
// becomes "5 dollars million"): they are a conservative stopgap until the
// FST backend replaces them.
const cleanEnglish = text => {
    let s = foldAllCaps(text)
    for (const [re, out] of SYMBOLS) s = s.replace(re, out)
    s = s.replace(/\$\s?(\d[\d,.]*)/g, '$1 dollars')
    s = s.replace(/(\d)\s*%/g, '$1 percent')
    s = s.replace(NUMBER_ABBR, 'Number')
    for (const [abbr, full] of Object.entries(ABBREVIATIONS))
        s = s.replace(new RegExp(`\\b${escapeRegExp(abbr)}(?=[\\s.,;:!?)]|$)`, 'g'),
            full)
    return s
}

// The 'rules' backend: pure, microseconds-fast, so it needs no cache of
// its own — the audio cache already keys on the normalized text, which
// means a re-read is free and a rule change simply misses.
const normalizeRules = (text, lang) => {
    let s = cleanUniversal(text)
    if (/^en\b/i.test(lang || 'en')) s = cleanEnglish(s)
    return s.replace(/[ \t\r\n]+/g, ' ').trim()
}

let backend = 'rules'

// Choose the backend once, at startup, from the 'tts-normalizer' setting.
// Unknown names are rejected rather than silently ignored: a typo must not
// turn normalization off.
export const setNormalizeBackend = name => {
    if (name !== 'rules' && name !== 'none' && name !== 'fst')
        throw new Error(`unknown text normalizer backend: ${name}`)
    backend = name
}
export const getNormalizeBackend = () => backend

// The one entry point. Always returns a string; never throws on odd input.
export const normalizeText = (text, lang = 'en') => {
    if (typeof text !== 'string') return ''
    if (backend === 'rules') return normalizeRules(text, lang)
    return text // 'none' and the reserved 'fst' pass through untouched
}
