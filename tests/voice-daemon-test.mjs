import { exit } from 'system'
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import Soup from 'gi://Soup?version=3.0'

// Isolation first: pack dirs and the wav cache stay out of the real home.
const tmp = GLib.dir_make_tmp(null)
GLib.setenv('XDG_DATA_HOME', tmp, true)
GLib.setenv('XDG_CACHE_HOME', tmp, true)

import { getPacks, packDir, NARRATORS } from '../src/voice-packs.js'
import { LocalTTS } from '../src/local-tts.js'
import { daemonVoiceLabel, daemonConfig, VoiceDaemon } from '../src/voice-daemon.js'

let failures = 0
const assert = (cond, msg) => {
    if (cond) return
    failures++
    printerr(`FAIL: ${msg}`)
}

const decode = bytes => new TextDecoder().decode(bytes)
const readText = path => decode(
    Gio.File.new_for_path(path).load_contents(null)[1])
const readTextOr = (path, fallback) =>
    GLib.file_test(path, GLib.FileTest.EXISTS) ? readText(path) : fallback
const fakeDir = GLib.build_filenamev([tmp, 'fake'])
GLib.mkdir_with_parents(fakeDir, 0o755)
const writeScript = (name, content) => {
    const path = GLib.build_filenamev([fakeDir, name])
    Gio.File.new_for_path(path).replace_contents(content, null, false,
        Gio.FileCreateFlags.NONE, null)
    Gio.File.new_for_path(path).set_attribute_uint32(
        Gio.FILE_ATTRIBUTE_UNIX_MODE, 0o755,
        Gio.FileQueryInfoFlags.NONE, null)
    return path
}

// a known 44-byte RIFF header: 16 kHz mono 16-bit, 32000 data bytes, so
// the readiness probe and the daemon fixture both produce a valid wav
const header = new Uint8Array(44)
{
    const view = new DataView(header.buffer)
    const put = (offset, str) => {
        for (let i = 0; i < str.length; i++)
            view.setUint8(offset + i, str.charCodeAt(i))
    }
    put(0, 'RIFF')
    view.setUint32(4, 32036, true) // riff size: file size - 8
    put(8, 'WAVE')
    put(12, 'fmt ')
    view.setUint32(16, 16, true) // fmt chunk size
    view.setUint16(20, 1, true) // PCM
    view.setUint16(22, 1, true) // mono
    view.setUint32(24, 16000, true) // sample rate
    view.setUint32(28, 32000, true) // byte rate
    view.setUint16(32, 2, true) // block align
    view.setUint16(34, 16, true) // bits per sample
    put(36, 'data')
    view.setUint32(40, 32000, true) // data chunk size
}
const wavWrite = path => {
    const out = Gio.File.new_for_path(path)
        .replace(null, false, Gio.FileCreateFlags.NONE, null)
    out.write_bytes(new GLib.Bytes(header), null)
    out.write_bytes(new GLib.Bytes(new Uint8Array(32000)), null)
    out.close(null)
}

// fake engine like the one in local-tts-test.mjs: dumps argv one per line,
// writes the known wav at the --output-filename path, counts invocations
const headerPath = GLib.build_filenamev([fakeDir, 'header.bin'])
{
    const out = Gio.File.new_for_path(headerPath)
        .replace(null, false, Gio.FileCreateFlags.NONE, null)
    out.write_bytes(new GLib.Bytes(header), null)
    out.close(null)
}
const writer = writeScript('fake-writer.sh', `#!/bin/sh
dir=$(dirname "$0")
: > "$dir/args.last"
for arg; do
    case "$arg" in
        --output-filename=*) wav="\${arg#--output-filename=}" ;;
    esac
    printf '%s\\n' "$arg" >> "$dir/args.last"
done
cat "${headerPath}" > "$wav"
head -c 32000 /dev/zero >> "$wav"
echo x >> "$dir/runs"
`)
GLib.setenv('FOLIATE_TTS_CMD', writer, true)
const argsLast = () => readTextOr(
    GLib.build_filenamev([fakeDir, 'args.last']), '').split('\n').filter(Boolean)

const packs = getPacks()
const kokoro = packs.find(p => p.id === 'kokoro')
const supertonic = packs.find(p => p.id === 'supertonic')
const piper = packs.find(p => p.id === 'piper')

// --- the daemon catalog carries every language x narrator pair ---

const toml = daemonConfig([kokoro, supertonic, piper])
const blocks = toml.split('[[voices]]').slice(1).map(block => block.trim())
const blocksFor = label => blocks.filter(block =>
    block.includes(`label = "${label}"`))

assert(blocks.length === supertonic.languages.length * NARRATORS.length +
        2,
'the catalog has 31 x 10 supertonic voices plus one each for kokoro ' +
    `and piper (got ${blocks.length})`)

// exact examples per the plan
assert(blocksFor('supertonic-en-f1').length === 1 &&
    blocksFor('supertonic-en-f1')[0].includes('sid = 0'),
'supertonic-en-f1 carries sid = 0')
assert(blocksFor('supertonic-fr-m5').length === 1 &&
    blocksFor('supertonic-fr-m5')[0].includes('sid = 9'),
'supertonic-fr-m5 carries sid = 9')

// round trip over every language x SID pair: the generated label resolves
// to exactly one block that carries the same sid and lang
const labels = new Set()
for (const lang of supertonic.languages) {
    for (const { sid } of NARRATORS) {
        const label = daemonVoiceLabel(supertonic, lang, sid)
        labels.add(label)
        const found = blocksFor(label)
        assert(found.length === 1,
            `${label} appears exactly once in the TOML`)
        assert(found[0]?.includes(`sid = ${sid}`),
            `${label} block carries sid = ${sid}`)
        assert(found[0]?.includes(`lang = "${lang}"`),
            `${label} block carries lang = '${lang}'`)
        assert(found[0]?.includes('model = "supertonic"'),
            `${label} block belongs to the supertonic model`)
    }
}
assert(labels.size === supertonic.languages.length * NARRATORS.length,
    `labels are unique per language/style pair (got ${labels.size})`)

// non-Supertonic packs keep their bare ids and pack sids; the sid arg is
// ignored entirely
assert(daemonVoiceLabel(kokoro, 'en', 23) === 'kokoro',
    'kokoro label is the bare pack id')
assert(daemonVoiceLabel(kokoro, 'en', 9) === 'kokoro',
    'kokoro label ignores the sid argument')
assert(daemonVoiceLabel(piper, 'en', 0) === 'piper',
    'piper label is the bare pack id')
assert(daemonVoiceLabel(piper, 'en', 9) === 'piper',
    'piper label ignores the sid argument')
assert(blocksFor('kokoro').length === 1 &&
    blocksFor('kokoro')[0].includes('sid = 23') &&
    blocksFor('kokoro')[0].includes('model = "kokoro"') &&
    !blocksFor('kokoro')[0].includes('lang ='),
'kokoro keeps its single current entry with sid = 23')
assert(blocksFor('piper').length === 1 &&
    blocksFor('piper')[0].includes('sid = 0') &&
    blocksFor('piper')[0].includes('model = "piper"') &&
    !blocksFor('piper')[0].includes('lang ='),
'piper keeps its single current entry with sid = 0')

// --- real request path: daemon posts the selected narrator's label ---

// real fixture pack files on disk so the readiness gate is exercised, not
// bypassed
const packFixture = pack => {
    const dir = packDir(pack.id)
    // GLib caches the user data dir at process start, so a bare `gjs` run
    // (without the isolated runner's env) would see the real home here;
    // refuse to write fake files outside the test root.
    if (!GLib.canonicalize_filename(dir, null).startsWith(`${tmp}/`)) {
        printerr('XDG_DATA_HOME isolation failed: refusing to write ' +
            `fixture files outside the test root: ${dir}`)
        exit(1)
    }
    GLib.mkdir_with_parents(dir, 0o755)
    for (const name of pack.expectedFiles)
        GLib.file_set_contents(`${dir}/${name}`, 'fixture')
    return pack
}
packFixture(supertonic)

const server = new Soup.Server()
const requests = []
server.add_handler('/v1/audio/speech', (srv, msg) => {
    const raw = msg.get_request_body().data
    requests.push(raw ? decode(raw) : '')
    msg.set_status(Soup.Status.OK, null)
    msg.get_response_body().append_bytes(new GLib.Bytes(header))
})
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY)
const serverUri = server.get_uris()[0].to_string().replace(/\/$/, '')
assert(/^http:\/\/127\.0\.0\.1:\d+$/.test(serverUri),
    `the fixture server listens on localhost (got ${serverUri})`)

// a daemon pointed at an existing baseUri must not spawn a process
const live = new VoiceDaemon({ baseUri: serverUri })
assert(live.running, 'a constructed daemon reports running so LocalTTS can use it')
await live.start()
assert(live.running,
    'start() on a baseUri-backed daemon spawns nothing and stays running')

const partPath = GLib.build_filenamev([tmp, 'request.wav'])
const duration = await live.synth('Bonjour tout le monde.', partPath,
    supertonic, { lang: 'fr', sid: 9 })
assert(requests.length === 1, 'the fixture server saw exactly one request')
let body = null
try { body = JSON.parse(requests[0]) } catch { /* handled below */ }
assert(body?.voice === 'supertonic-fr-m5',
    `the request voice is supertonic-fr-m5 (got ${
        requests[0]?.slice(0, 200)})`)
assert(body?.input === 'Bonjour tout le monde.',
    'the request carries the spoken text')
assert(GLib.file_test(partPath, GLib.FileTest.IS_REGULAR),
    'the daemon response landed at the part path')
assert(duration > 0, 'the response parses as a wav')

// --- LocalTTS: the resolved sid reaches the daemon and forks the cache ---

const fakeDaemon = {
    running: true,
    seen: [],
    async synth(text, part, pack, { lang, sid } = {}) {
        this.seen.push({ text, pack: pack.id, lang, sid })
        wavWrite(part)
        return 1
    },
}
const cacheC = GLib.build_filenamev([tmp, 'cache-c'])
const tts = new LocalTTS({ cacheDir: cacheC, daemon: fakeDaemon })

const wav0 = (await tts.synth('Hello world.', supertonic,
    { lang: 'en', sid: 0 })).wavPath
const wav9 = (await tts.synth('Hello world.', supertonic,
    { lang: 'en', sid: 9 })).wavPath
assert(wav0 !== wav9,
    'sid 0 and sid 9 produce distinct cache entries')
const sids0 = new Set(fakeDaemon.seen.map(call => call.sid))
assert(sids0.has(0) && sids0.has(9),
    `the resolved sids reached the daemon path (got ${
        [...sids0].join(', ')})`)
assert(fakeDaemon.seen.every(call => call.pack === 'supertonic'),
    'the daemon calls carried the supertonic pack')

const before = fakeDaemon.seen.length
const again = (await tts.synth('Hello world.', supertonic,
    { lang: 'en', sid: 9 })).wavPath
assert(again === wav9, 'repeating sid 9 is a cache hit')
assert(fakeDaemon.seen.length === before,
    'the cache hit made no second synth call')

// --- a language outside pack.languages falls back to the CLI engine ---

const cnt = () => readTextOr(
    GLib.build_filenamev([fakeDir, 'runs']), '').split('\n').filter(Boolean).length
const runsBefore = cnt()
const seenBefore = fakeDaemon.seen.length
const outside = (await tts.synth('Unheard sentence.', supertonic,
    { lang: 'xx', sid: 9 })).wavPath
assert(cnt() === runsBefore + 1,
    'an unsupported language ran the CLI engine instead of the daemon')
assert(fakeDaemon.seen.length === seenBefore,
    'the daemon was not asked for an unsupported language')
assert(argsLast().some(arg => arg === '--sid=9'),
    `the CLI argv carries the selected sid (got ${argsLast().join(' ')})`)
assert(GLib.file_test(outside, GLib.FileTest.IS_REGULAR),
    'the CLI fallback produced a wav')

await new Promise(resolve =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50,
        () => (resolve(), GLib.SOURCE_REMOVE)))

if (failures) {
    printerr(`${failures} test${failures > 1 ? 's' : ''} failed`)
    exit(1)
}
print('All tests passed')
