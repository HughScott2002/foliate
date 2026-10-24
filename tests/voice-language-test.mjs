import * as voices from '../src/voice-packs.js'
const check = (ok, message) => { if (!ok) throw new Error(message) }
check(typeof voices.pickPackForLanguage === 'function', 'language auto-pick missing')
for (const [language, id] of [
    ['en', 'kokoro'], ['en-US', 'kokoro'], ['ZH-cn', 'kokoro'],
    ['fr', 'supertonic'], ['fr-CA', 'supertonic'], ['lt', 'supertonic'],
    ['he', undefined], ['th', undefined], ['xx', undefined],
]) check(voices.pickPackForLanguage(language)?.id === id, `wrong voice for ${language}`)
check(voices.getPacks().every(pack => /^[0-9a-f]{64}$/.test(pack.sha256)),
    'voice downloads must have pinned checksums')
print('Voice language matching and checksum tests passed')
