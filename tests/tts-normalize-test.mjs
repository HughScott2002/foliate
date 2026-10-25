import { exit } from 'system'
import { normalizeText, setNormalizeBackend, getNormalizeBackend } from '../src/tts-normalize.js'

// Each case names the break it catches: a rule missing or mis-ordered makes
// exactly one of these fail. Table-driven with hand-written expectations.
let failures = 0
const check = (input, want, label, lang = 'en') => {
    const got = normalizeText(input, lang)
    if (got === want) return
    failures++
    printerr(`FAIL: ${label}\n  in:   ${JSON.stringify(input)}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`)
}
const ok = (cond, label) => {
    if (cond) return
    failures++
    printerr(`FAIL: ${label}`)
}

// --- interface: the backend is swappable without changing callers ---
ok(getNormalizeBackend() === 'rules', 'default backend is rules')
check('Dr. Smith & Co.', 'Doctor Smith and Co.', 'rules backend applies')
setNormalizeBackend('none')
check('Dr. Smith & Co.', 'Dr. Smith & Co.', 'none backend is identity')
setNormalizeBackend('fst')
check('Dr. Smith & Co.', 'Dr. Smith & Co.',
    'reserved fst backend is identity in JS (FST runs in the engine)')
let rejected = false
try { setNormalizeBackend('bogus') } catch { rejected = true }
ok(rejected, 'unknown backend is rejected, not silently ignored')
setNormalizeBackend('rules')

// --- universal cleanups ---
check('ex\u00ADample', 'example', 'soft hyphen removed')
check('some-\nthing', 'something', 'line-break hyphen joined')
check('self-aware', 'self-aware', 'a real hyphen survives (no newline)')
check('of\ufb01ce', 'office', 'ligature fi')
check('\ufb02ow', 'flow', 'ligature fl')
check('  a   b  ', 'a b', 'whitespace collapsed and trimmed')
// universal cleanups apply in any language
check('ex\u00ADample', 'example', 'soft hyphen removed (de)', 'de')
check('a\u00A7b', 'a\u00A7b', 'section sign untouched in German', 'de')

// --- English: abbreviations, whole tokens only ---
check('Dr. Smith', 'Doctor Smith', 'Dr. expanded')
check('etc. and so on', 'et cetera and so on', 'etc. expanded')
check('e.g. this', 'for example this', 'e.g. expanded')
check('e.g., this', 'for example, this', 'e.g. before a comma')
check('Mr. and Mrs. Jones', 'Mister and Missus Jones', 'Mr./Mrs. expanded')
check('Dread it', 'Dread it', 'does not touch words starting like an abbr')
check('No. Smith', 'No. Smith', 'No. is the word no, not Number')
check('No. 5', 'Number 5', 'No. before a digit is Number')
// English rewrites are gated off for other languages
check('Dr. Smith', 'Dr. Smith', 'abbreviations untouched in German', 'de')

// --- English: symbols and numbers with units ---
check('Tom & Jerry', 'Tom and Jerry', 'ampersand')
check('section \u00A7 4', 'section section 4', 'section sign by glyph')
check('a + b', 'a plus b', 'plus')
check('50%', '50 percent', 'percent')
check('$5', '5 dollars', 'currency')
check('yes\u2014really', 'yes, really', 'em dash to comma pause')
check('a\u2026b', 'a...b', 'ellipsis to dots')
check('Version 2.0', 'Version 2.0', 'decimal numbers untouched')
check('Hello, world!', 'Hello, world!', 'plain text untouched')

// --- odd input never throws ---
check('', '', 'empty string')
check(null, '', 'null is empty')
check(undefined, '', 'undefined is empty')

if (failures) {
    printerr(`${failures} test${failures > 1 ? 's' : ''} failed`)
    exit(1)
}
print('TTS text normalization tests passed')
