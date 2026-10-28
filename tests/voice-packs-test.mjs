import { exit } from 'system'
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'

// Keep test state out of the real ~/.local/share/foliate: repoint
// XDG_DATA_HOME at a temp dir before any packDir() call (resolution is lazy
// inside the module, so this takes effect).
GLib.setenv('XDG_DATA_HOME', GLib.dir_make_tmp(null), true)

import {
    getPacks,
    packDir,
    verifyPack,
    getInstalledPacks,
    getPackState,
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
assert(packs.find(p => p.id === 'supertonic').languages.length === 31,
    'supertonic lists 31 languages')
assert(['en', 'lt', 'fr'].every(l =>
    packs.find(p => p.id === 'supertonic').languages.includes(l)),
'supertonic languages include en, lt, fr')
assert(packs.find(p => p.id === 'kokoro').sid === 23, 'kokoro default sid is 23')
assert(packs.find(p => p.id === 'supertonic').sid === 0,
    'supertonic default sid is 0')
assert(packs.find(p => p.id === 'piper').sizeMB === 64, 'piper sizeMB is 64')
assert(packs.every(p => p.sha256 === null || /^[0-9a-f]{64}$/i.test(p.sha256)),
    'sha256 is null or a 64-char hex digest')
assert(typeof packs.find(p => p.id === 'supertonic').default === 'boolean',
    'supertonic has a default marker')
assert(JSON.stringify(packs.filter(p => p.default).map(p => p.id))
        === JSON.stringify(['supertonic']),
'supertonic is the only default pack')
assert(packs.every(p => typeof p.label === 'string'), 'every pack has a label')
assert(packs.every(p => typeof p.sample === 'string'), 'every pack has a sample')
assert(packs.every(p => Array.isArray(p.expectedFiles) && p.expectedFiles.length),
    'every pack lists expected files')

// runtime data coverage
assert(packs.find(p => p.id === 'kokoro').expectedFiles.includes('model.int8.onnx'),
    'kokoro expects model.int8.onnx')
assert(!packs.find(p => p.id === 'kokoro').expectedFiles.includes('model.onnx'),
    'kokoro does not expect model.onnx')
assert(['kokoro', 'piper'].every(id =>
    packs.find(p => p.id === id).expectedFiles.includes('espeak-ng-data')),
'espeak-ng-data is required by kokoro and piper')

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
assert(!installed.some(p => p.id === 'kokoro'),
    'kokoro not reported installed before download')

const kokoroPack = packs.find(p => p.id === 'kokoro')
const piperPack = packs.find(p => p.id === 'piper')

// getPackState distinguishes an absent directory from an existing empty one
assert(getPackState(piperPack).status === 'missing',
    'getPackState reports a missing pack directory')
assert(getPackState(piperPack).message === null,
    'missing pack state has no diagnostic message')

const emptyDir = Gio.File.new_for_path(packDir('piper'))
emptyDir.make_directory_with_parents(null)
assert(verifyPack(piperPack) === false, 'verifyPack false for an empty pack dir')
const emptyState = getPackState(piperPack)
assert(emptyState.status === 'invalid',
    'getPackState reports an existing empty pack as invalid')
assert(typeof emptyState.message === 'string' && emptyState.message.length > 0,
    'invalid pack state carries a diagnostic message')

// a regular file where the pack directory belongs is invalid, not missing
const stray = Gio.File.new_for_path(packDir('not-a-real-pack'))
GLib.file_set_contents(stray.get_path(), 'not a pack directory')
const strayPack = { ...kokoroPack, id: 'not-a-real-pack' }
const strayState = getPackState(strayPack)
assert(strayState.status === 'invalid',
    'getPackState reports a non-directory pack path as invalid')
assert(typeof strayState.message === 'string',
    'non-directory pack state carries a diagnostic message')
assert(verifyPack(strayPack) === false,
    'verifyPack false for a non-directory pack path')
stray.delete(null)

// full install -> verify -> delete cycle (runs in the temp XDG_DATA_HOME)
const dir = Gio.File.new_for_path(packDir('kokoro'))
dir.make_directory_with_parents(null)
// 'dict' and 'espeak-ng-data' ship as directories in the tarball
const DIRS = new Set(['espeak-ng-data', 'dict'])
for (const name of kokoroPack.expectedFiles) {
    if (DIRS.has(name)) dir.get_child(name).make_directory(null)
    else GLib.file_set_contents(
        dir.get_child(name).get_path(), 'placeholder model data')
}
assert(verifyPack(kokoroPack) === true, 'verifyPack true with all files present')
const installedState = getPackState(kokoroPack)
assert(installedState.status === 'installed',
    'getPackState reports a complete pack as installed')
assert(installedState.message === null,
    'installed pack state has no diagnostic message')
assert(getInstalledPacks().some(p => p.id === 'kokoro'),
    'getInstalledPacks() sees the installed pack')

// zero-byte required files are the known corruption signature: invalid
GLib.file_set_contents(dir.get_child('tokens.txt').get_path(), '')
assert(verifyPack(kokoroPack) === false,
    'verifyPack rejects a zero-byte required file')
const corruptState = getPackState(kokoroPack)
assert(corruptState.status === 'invalid',
    'getPackState reports zero-byte required files as invalid')
assert(/empty/i.test(corruptState.message),
    `invalid state names the empty file (got: ${corruptState.message})`)
assert(!getInstalledPacks().some(p => p.id === 'kokoro'),
    'getInstalledPacks() drops a pack with zero-byte required files')

// restoring nonempty content recovers the installed state
GLib.file_set_contents(dir.get_child('tokens.txt').get_path(), 'tokens')
assert(getPackState(kokoroPack).status === 'installed',
    'getPackState returns installed after the empty file is fixed')

assert(deletePack('kokoro') === true, 'deletePack removes the installed pack')
assert(verifyPack(kokoroPack) === false, 'verifyPack false again after delete')
assert(getPackState(kokoroPack).status === 'missing',
    'getPackState returns missing after delete')

// deleting a missing pack must not throw
assert(deletePack('not-a-real-pack') === false,
    'deletePack on missing pack returns false without throwing')

// download is implemented in Task 2 (see tests/voice-packs-download-test.mjs)
assert(typeof download === 'function', 'download is exported')

if (failures) {
    printerr(`${failures} test${failures > 1 ? 's' : ''} failed`)
    exit(1)
}
print('All tests passed')
