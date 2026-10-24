import { exit } from 'system'
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'

import {
    getPacks,
    packDir,
    verifyPack,
    getInstalledPacks,
    download,
    deletePack,
} from '../src/voice-packs.js'

let failures = 0
const assert = (cond, msg) => {
    if (cond) return
    failures++
    printerr(`FAIL: ${msg}`)
}

const kokoro = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2'
const supertonic = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2'
const piper = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-low.tar.bz2'

// catalog
const packs = getPacks()
assert(packs.length === 3, 'getPacks() returns 3 packs')
assert(packs.find(p => p.id === 'kokoro').sizeMB > 100, 'kokoro sizeMB > 100')
assert(packs.find(p => p.id === 'kokoro').url === kokoro, 'kokoro url is pinned')
assert(packs.find(p => p.id === 'supertonic').url === supertonic,
    'supertonic url is pinned')
assert(packs.find(p => p.id === 'piper').url === piper, 'piper url is pinned')
assert(packs.find(p => p.id === 'kokoro').languages.join() === 'en,zh',
    'kokoro languages are en, zh')
assert(packs.find(p => p.id === 'kokoro').sid === 23, 'kokoro default sid is 23')
assert(packs.find(p => p.id === 'supertonic').sid === 0,
    'supertonic default sid is 0')
assert(packs.find(p => p.id === 'supertonic').numLanguages === 31,
    'supertonic reports 31 languages')
assert(packs.find(p => p.id === 'piper').sizeMB === 79, 'piper sizeMB is 79')
assert(packs.every(p => p.sha256 === null), 'sha256 placeholders are null')
assert(packs.every(p => typeof p.label === 'string'), 'every pack has a label')
assert(packs.every(p => typeof p.sample === 'string'), 'every pack has a sample')
assert(packs.every(p => Array.isArray(p.expectedFiles) && p.expectedFiles.length),
    'every pack lists expected files')

// paths
assert(packDir('kokoro').endsWith('/foliate/voices/kokoro'),
    `packDir ends with /foliate/voices/kokoro (got ${packDir('kokoro')})`)
assert(packDir('kokoro') !== packDir('piper'), 'packDir differs per pack id')

// installed packs
const installed = getInstalledPacks()
assert(Array.isArray(installed), 'getInstalledPacks() returns an array')
const knownIds = packs.map(p => p.id)
assert(installed.every(p => knownIds.includes(p.id)),
    'getInstalledPacks() only lists known packs')

// verifyPack on a pack that is not installed
const notInstalled = !GLib.file_test(packDir('kokoro'), GLib.FileTest.IS_DIR)
assert(notInstalled ? verifyPack(packs[0]) === false : true,
    'verifyPack returns false when pack is absent')

// full install -> verify -> delete cycle, only when safe (dir absent)
if (notInstalled) {
    const dir = Gio.File.new_for_path(packDir('kokoro'))
    dir.make_directory_with_parents(null)
    for (const name of packs[0].expectedFiles)
        dir.get_child(name).create(Gio.FileCreateFlags.NONE, null).close(null)
    assert(verifyPack(packs[0]) === true, 'verifyPack true with all files present')
    assert(getInstalledPacks().some(p => p.id === 'kokoro'),
        'getInstalledPacks() sees the installed pack')
    assert(deletePack('kokoro') === true, 'deletePack removes the installed pack')
    assert(verifyPack(packs[0]) === false, 'verifyPack false again after delete')
} else {
    printerr('skipping install cycle: kokoro pack already exists')
}

// deleting a missing pack must not throw
assert(deletePack('not-a-real-pack') === false,
    'deletePack on missing pack returns false without throwing')

// download is a stub in Task 1
try {
    await download(packs[0])
    failures++
    printerr('FAIL: download() should reject')
} catch (e) {
    assert(/not implemented/i.test(e.message),
        `download rejects with clear error (got: ${e.message})`)
}

if (failures) {
    printerr(`${failures} test${failures > 1 ? 's' : ''} failed`)
    exit(1)
}
print('All tests passed')
