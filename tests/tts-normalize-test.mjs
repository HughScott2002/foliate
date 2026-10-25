import { exit } from 'system'
import { normalizeSentence } from '../src/tts-normalize.js'

// Each case names the break it catches: a rule missing or mis-ordered makes
// exactly one of these fail. Table-driven with hand-written expectations.
let failures = 0
const check = (input, want, label) => {
    const got = normalizeSentence(input, 'en')
    if (got === want) return
    failures++
    printerr(`FAIL: ${label}\n  in:   ${JSON.stringify(input)}\n  got:  ${JSON.stringify(got)}\n  want: ${JSON.stringify(want)}`)
}

// soft hyphens are never spoken
check('ex\u00ADample', 'example', 'soft hyphen removed')
// a hyphen across a line break is a wrapped word
check('some-\nthing', 'something', 'line-break hyphen joined')
check('self-aware', 'self-aware', 'a real hyphen survives (no newline)')
// ligatures
check('of\ufb01ce', 'office', 'ligature fi')
check('\ufb02ow', 'flow', 'ligature fl')
// abbreviations, whole tokens only
check('Dr. Smith', 'Doctor Smith', 'Dr. expanded')
check('etc. and so on', 'et cetera and so on', 'etc. expanded')
check('e.g. this', 'for example this', 'e.g. expanded')
check('Mr. and Mrs. Jones', 'Mister and Missus Jones', 'Mr./Mrs. expanded')
check('Dread it', 'Dread it', 'does not touch words starting like an abbr')
// symbols
check('Tom & Jerry', 'Tom and Jerry', 'ampersand')
check('section \u00A7 4', 'section section 4', 'section sign by glyph')
check('a + b', 'a plus b', 'plus')
// numbers with units
check('50%', '50 percent', 'percent')
check('$5', '5 dollars', 'currency')
// dashes become a spoken pause
check('yes\u2014really', 'yes, really', 'em dash to comma pause')
check('a\u2026b', 'a...b', 'ellipsis to dots')
// whitespace is tidied
check('  a   b  ', 'a b', 'whitespace collapsed and trimmed')
// no normalization for digits/letters we do not intend to touch
check('Version 2.0', 'Version 2.0', 'decimal numbers untouched')
check('Hello, world!', 'Hello, world!', 'plain text untouched')
// odd input never throws
check('', '', 'empty string')
check(null, '', 'null is empty')
check(undefined, '', 'undefined is empty')

if (failures) {
    printerr(`${failures} test${failures > 1 ? 's' : ''} failed`)
    exit(1)
}
print('TTS text normalization tests passed')
