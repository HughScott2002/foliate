// Text normalization for the TTS front end: the last thing the reader's
// text passes through before it becomes speech. It fixes the things that
// make any engine (neural or speech-dispatcher) misread a book — soft
// hyphens, ligatures, abbreviations, symbols — so nothing malformed reaches
// the model. Pure and cheap (microseconds), so it needs no cache of its
// own: the audio cache already keys on the normalized text, which means a
// re-read is free and a rule change simply misses.

// Ligature characters that should be spoken as their letters.
const LIGATURES = {
    '\uFB00': 'ff', '\uFB01': 'fi', '\uFB02': 'fl', '\uFB03': 'ffi',
    '\uFB04': 'ffl', '\uFB05': 'st', '\uFB06': 'st',
}

// Abbreviations read out in full. Keyed exactly; only matched as whole
// tokens (word boundary before, whitespace or end after).
const ABBREVIATIONS = {
    'Dr.': 'Doctor', 'Mr.': 'Mister', 'Mrs.': 'Missus', 'Ms.': 'Miss',
    'Prof.': 'Professor', 'St.': 'Saint', 'Jr.': 'Junior', 'Sr.': 'Senior',
    'etc.': 'et cetera', 'e.g.': 'for example', 'i.e.': 'that is',
    'vs.': 'versus', 'Fig.': 'Figure', 'No.': 'Number',
    'approx.': 'approximately', 'Dept.': 'Department',
}

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

// One sentence of book text in, the text to speak out. Returns a trimmed
// string; never throws on odd input.
export const normalizeSentence = text => {
    if (typeof text !== 'string') return ''
    let s = text
    // soft hyphen: an invisible break hint, never spoken
    s = s.replace(/\u00AD/g, '')
    // a hyphen at a line break is a wrapped word, not a hyphenated one
    s = s.replace(/(\p{L})-\n(\p{L})/gu, '$1$2')
    for (const [lig, letters] of Object.entries(LIGATURES))
        s = s.split(lig).join(letters)
    for (const [re, out] of SYMBOLS) s = s.replace(re, out)
    // currency and percent: "5%" -> "5 percent", "$5" -> "5 dollars"
    s = s.replace(/\$\s?(\d[\d,.]*)/g, '$1 dollars')
    s = s.replace(/(\d)\s*%/g, '$1 percent')
    for (const [abbr, full] of Object.entries(ABBREVIATIONS))
        s = s.replace(new RegExp(`\\b${escapeRegExp(abbr)}(?=\\s|$)`, 'g'), full)
    // collapse runs of whitespace the substitutions may have introduced
    return s.replace(/[ \t\r\n]+/g, ' ').trim()
}
