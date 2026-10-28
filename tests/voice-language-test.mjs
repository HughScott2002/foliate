import GLib from 'gi://GLib'
// set before the module resolves the data dir (GLib caches it)
const tmp = GLib.dir_make_tmp('choose-pack-XXXXXX')
GLib.setenv('XDG_DATA_HOME', tmp, true)
import * as voices from '../src/voice-packs.js'
import { getPacks, packDir } from '../src/voice-packs.js'
const check = (ok, message) => { if (!ok) throw new Error(message) }
check(typeof voices.pickPackForLanguage === 'function', 'language auto-pick missing')
for (const [language, id] of [
    ['en', 'kokoro'], ['en-US', 'kokoro'], ['ZH-cn', 'kokoro'],
    ['fr', 'supertonic'], ['fr-CA', 'supertonic'], ['lt', 'supertonic'],
    ['he', undefined], ['th', undefined], ['xx', undefined],
]) check(voices.pickPackForLanguage(language)?.id === id, `wrong voice for ${language}`)
check(voices.getPacks().every(pack => /^[0-9a-f]{64}$/.test(pack.sha256)),
    'voice downloads must have pinned checksums')
check(typeof voices.choosePack === 'function', 'pack selection helper missing')

// choosePack: no packs installed -> default pack (supertonic) drives download
check(voices.choosePack({ language: 'en' }).id === 'supertonic',
    'no installed pack -> default pack')
check(voices.choosePack({ saved: 'piper', language: 'en' }).id === 'piper',
    'saved per-book choice wins')
check(voices.choosePack({ saved: 'nope', language: 'en' }).id === 'supertonic',
    'unknown saved id is ignored')

// install only piper: an English book then uses piper (no default installed)
const install = pack => {
    GLib.mkdir_with_parents(packDir(pack.id), 0o700)
    for (const name of pack.expectedFiles) {
        if (['dict', 'espeak-ng-data'].includes(name))
            GLib.mkdir_with_parents(`${packDir(pack.id)}/${name}`, 0o700)
        else GLib.file_set_contents(`${packDir(pack.id)}/${name}`, 'placeholder')
    }
}
install(getPacks().find(p => p.id === 'piper'))
check(voices.choosePack({ language: 'en' }).id === 'piper',
    'only piper installed -> piper for English')
// install the default too: it must win over the language match
install(getPacks().find(p => p.id === 'supertonic'))
check(voices.choosePack({ language: 'en' }).id === 'supertonic',
    'installed default beats a language match')
check(voices.choosePack({ language: 'lt' }).id === 'supertonic',
    'default covers a language only it supports')

// Canonical Supertonic narrator catalogue: SID order 0-9, official preset
// codes, Foliate names, and the approved short descriptions.
const EXPECTED_NARRATORS = [
    { sid: 0, preset: 'f1', name: 'Amy', description: 'Calm and steady' },
    { sid: 1, preset: 'f2', name: 'Lily', description: 'Bright and playful' },
    { sid: 2, preset: 'f3', name: 'Clara', description: 'Clear announcer' },
    { sid: 3, preset: 'f4', name: 'Vivian', description: 'Crisp and confident' },
    { sid: 4, preset: 'f5', name: 'Grace', description: 'Kind and gentle' },
    { sid: 5, preset: 'm1', name: 'Leo', description: 'Lively and upbeat' },
    { sid: 6, preset: 'm2', name: 'Graham', description: 'Deep and composed' },
    { sid: 7, preset: 'm3', name: 'Victor', description: 'Authoritative and polished' },
    { sid: 8, preset: 'm4', name: 'Elliot', description: 'Gentle and friendly' },
    { sid: 9, preset: 'm5', name: 'Theo', description: 'Warm storyteller' },
]
check(Array.isArray(voices.NARRATORS), 'narrator catalogue missing')
check(voices.NARRATORS.length === EXPECTED_NARRATORS.length,
    'narrator catalogue must hold ten records')
for (const [index, expected] of EXPECTED_NARRATORS.entries()) {
    const actual = voices.NARRATORS[index]
    check(actual?.sid === expected.sid, `narrator ${index} has wrong SID`)
    check(actual?.preset === expected.preset,
        `narrator ${index} has wrong preset`)
    check(actual?.name === expected.name, `narrator ${index} has wrong name`)
    check(actual?.description === expected.description,
        `narrator ${index} has wrong description`)
}

check(typeof voices.narratorLabel === 'function', 'narrator label missing')
check(voices.narratorLabel(0) === 'Amy — Calm and steady',
    'narrator 0 label is wrong')
check(voices.narratorLabel(7) === 'Victor — Authoritative and polished',
    'narrator 7 label is wrong')
for (const invalid of [undefined, null, -1, 10, 1.5, '3', NaN, {}])
    check(voices.narratorLabel(invalid) === 'Amy — Calm and steady',
        `invalid SID ${String(invalid)} must show the F1 label`)

check(typeof voices.presetCodeForSid === 'function', 'preset lookup missing')
for (const expected of EXPECTED_NARRATORS)
    check(voices.presetCodeForSid(expected.sid) === expected.preset,
        `wrong preset code for SID ${expected.sid}`)
for (const invalid of [undefined, null, -1, 10, 1.5, '3', NaN, {}])
    check(voices.presetCodeForSid(invalid) === 'f1',
        `invalid SID ${String(invalid)} must fall back to f1`)

check(typeof voices.resolveNarratorSid === 'function', 'SID resolver missing')
for (const [stored, globalSid, sid, followsDefault] of [
    [0, 7, 0, false],
    [5, 0, 5, false],
    [9, 9, 9, false],
    [undefined, 7, 7, true],
    [null, 3, 3, true],
    [-1, 4, 4, true],
    [10, 4, 4, true],
    [2.5, 4, 4, true],
    ['3', 4, 4, true],
    [NaN, 4, 4, true],
    [{}, 4, 4, true],
    [undefined, 99, 0, true],
    [null, undefined, 0, true],
    [10, -1, 0, true],
    [0, 99, 0, false],
]) {
    const result = voices.resolveNarratorSid({ stored, globalSid })
    check(result?.sid === sid && result.followsDefault === followsDefault,
        `resolveNarratorSid(${String(stored)}, ${String(globalSid)}) is wrong`)
}

print('Voice language matching, pack choice and checksum tests passed')
