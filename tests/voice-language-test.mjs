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
        else GLib.file_set_contents(`${packDir(pack.id)}/${name}`, '')
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

print('Voice language matching, pack choice and checksum tests passed')
