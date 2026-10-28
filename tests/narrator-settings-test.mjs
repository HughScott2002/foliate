import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
// set before any module resolves the data dir (GLib caches it)
const tmp = GLib.dir_make_tmp('narrator-settings-XXXXXX')
GLib.setenv('XDG_DATA_HOME', tmp, true)
GLib.setenv('XDG_CACHE_HOME', tmp, true)
GLib.setenv('XDG_CONFIG_HOME', tmp, true)
GLib.setenv('GSETTINGS_BACKEND', 'memory', true)

import * as voices from '../src/voice-packs.js'
import { JSONStorage } from '../src/utils.js'

const check = (ok, message) => { if (!ok) throw new Error(message) }

// --- resolveNarratorSid: stored book SID wins; invalid input follows default ---
for (const [stored, globalSid, sid, followsDefault] of [
    [undefined, 0, 0, true],          // absent stored value -> global 0
    [null, 0, 0, true],               // reset book follows the global
    [null, 3, 3, true],
    [0, 7, 0, false],                 // explicit book 0 is a real choice
    [7, 7, 7, false],                 // book choice equal to global stays book
    [-1, 4, 4, true],                 // out of range -> global
    [10, 4, 4, true],
    [2.5, 4, 4, true],                // non-integer -> global
    ['3', 4, 4, true],
    [NaN, 4, 4, true],
    [{}, 4, 4, true],
    [null, 99, 0, true],              // out-of-range global -> F1 (0)
    [null, undefined, 0, true],
]) {
    const resolved = voices.resolveNarratorSid({ stored, globalSid })
    check(resolved?.sid === sid && resolved.followsDefault === followsDefault,
        `resolveNarratorSid(${String(stored)}, ${String(globalSid)}) is wrong`)
}
const invalidStored = voices.resolveNarratorSid({ stored: 42 })
check(invalidStored.sid === 0 && invalidStored.followsDefault,
    'invalid stored SID without a global must fall back to 0')

// --- JSONStorage round-trip: the book file is JSON with one nullable key ---
const dataDir = GLib.build_filenamev([tmp, 'library'])
const resolveBook = (storage, globalSid) => voices.resolveNarratorSid({
    stored: storage.get('tts-supertonic-sid', null),
    globalSid,
})

// a fresh book has no stored SID
const storage = new JSONStorage(dataDir, 'narrator-book')
check(storage.get('tts-supertonic-sid', null) === null, 'absent key must read null')
check(resolveBook(storage, 0).sid === 0 && resolveBook(storage, 0).followsDefault,
    'absent -> follows global 0')

// book 0 is an explicit choice and survives global changes
storage.set('tts-supertonic-sid', 0)
storage.saveNow()
check(resolveBook(storage, 9).sid === 0 && !resolveBook(storage, 9).followsDefault,
    'book 0 must stay 0 after the global changes')

// book 7 likewise survives a global change
storage.set('tts-supertonic-sid', 7)
storage.saveNow()
check(resolveBook(storage, 1).sid === 7 && !resolveBook(storage, 1).followsDefault,
    'book 7 must stay 7 after the global changes')

// reset writes null; the book then follows the new global 3
storage.set('tts-supertonic-sid', null)
storage.saveNow()
check(storage.get('tts-supertonic-sid', null) === null, 'reset must store null')
check(resolveBook(storage, 3).sid === 3 && resolveBook(storage, 3).followsDefault,
    'null stored SID must follow the new global 3')

// reopening the JSON file preserves null (the key exists, value is null)
const reopened = new JSONStorage(dataDir, 'narrator-book')
check(reopened.get('tts-supertonic-sid', null) === null,
    'reopened storage must preserve null')
const [contents] = Gio.File.new_for_path(
    GLib.build_filenamev([dataDir, 'narrator-book.json'])).load_bytes(null)
const saved = JSON.parse(new TextDecoder().decode(contents.get_data()))
check(Object.keys(saved).length === 1
    && Object.hasOwn(saved, 'tts-supertonic-sid')
    && saved['tts-supertonic-sid'] === null,
`book file must hold only the nullable SID key, got ${JSON.stringify(saved)}`)

print('Narrator SID resolution and book storage round-trip tests passed')
