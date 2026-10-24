import { exit } from 'system'
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'

// Capture the real XDG_DATA_HOME before isolation: the manual smoke test
// at the end looks for a really-installed kokoro pack there.
const realDataHome = GLib.getenv('XDG_DATA_HOME') ??
    GLib.build_filenamev([GLib.get_home_dir(), '.local', 'share'])
const tmp = GLib.dir_make_tmp(null)
// Isolation first: pack dirs and the wav cache stay out of the real home.
GLib.setenv('XDG_DATA_HOME', tmp, true)
GLib.setenv('XDG_CACHE_HOME', tmp, true)

import { getPacks, packDir } from '../src/voice-packs.js'
import { buildEngineArgs, LocalTTS } from '../src/local-tts.js'

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
const fileSize = path => Gio.File.new_for_path(path).query_info(
    'standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size()
const testDir = GLib.canonicalize_filename(
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), null)
const srcDir = GLib.canonicalize_filename(
    GLib.build_filenamev([testDir, '..', 'src']), null)
const srcUri = name => Gio.File.new_for_path(
    GLib.build_filenamev([srcDir, name])).get_uri()

// poll until cond() holds; false when the deadline passes
const waitFor = async (cond, ms = 5000) => {
    const deadline = Date.now() + ms
    while (!cond()) {
        if (Date.now() > deadline) return false
        await new Promise(resolve =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20,
                () => (resolve(), GLib.SOURCE_REMOVE)))
    }
    return true
}

// a synth subprocess counts as an orphan if its /proc entry is still there:
// a live pid means it is running, a zombie means it was never reaped
const pidAlive = pid => GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS)

const writeScript = (name, content) => {
    const path = GLib.build_filenamev([fakeDir, name])
    Gio.File.new_for_path(path).replace_contents(content, null, false,
        Gio.FileCreateFlags.NONE, null)
    Gio.File.new_for_path(path).set_attribute_uint32(
        Gio.FILE_ATTRIBUTE_UNIX_MODE, 0o755,
        Gio.FileQueryInfoFlags.NONE, null)
    return path
}

// --- fixture: fake engines plus a fixed 44-byte RIFF header ---

const fakeDir = GLib.build_filenamev([tmp, 'fake'])
GLib.mkdir_with_parents(fakeDir, 0o755)

// the wav the fake engine writes: 16 kHz mono 16-bit, 32000 data bytes,
// so the RIFF size (44 + 32000 - 8 = 32036) gives a known duration
const header = new Uint8Array(44)
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
const headerPath = GLib.build_filenamev([fakeDir, 'header.bin'])
{
    const out = Gio.File.new_for_path(headerPath)
        .replace(null, false, Gio.FileCreateFlags.NONE, null)
    out.write_bytes(new GLib.Bytes(header), null)
    out.close(null)
}
// duration the parser must report: the data chunk (32000 bytes) over the
// byte rate — the RIFF size (44 + 32000 - 8) carries header bias and is
// no longer used
const expectedDuration = 32000 / 32000

// fake engine: dumps argv one arg per line, writes the known wav at the
// --output-filename path, counts invocations
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
const argsLast = () => readTextOr(
    GLib.build_filenamev([fakeDir, 'args.last']), '').split('\n').filter(Boolean)
const runCount = () => readTextOr(
    GLib.build_filenamev([fakeDir, 'runs']), '').split('\n').filter(Boolean).length

// fake engine that hangs until killed, leaving its pid behind as a marker
const sleeper = writeScript('fake-sleeper.sh', `#!/bin/sh
echo $$ > "$(dirname "$0")/pid"
exec sleep 30
`)
const pidMarker = () => GLib.build_filenamev([fakeDir, 'pid'])

// fake engine that fails loudly with a nonzero exit and stderr noise
const failing = writeScript('fake-failing.sh', `#!/bin/sh
echo 'engine exploded' >&2
exit 3
`)

// fake engine that writes a complete wav and THEN fails: the crash path
// must leave neither the .part staging file nor a cache-visible wav
const crashesAfterWrite = writeScript('fake-crash-after-write.sh', `#!/bin/sh
dir=$(dirname "$0")
for arg; do
    case "$arg" in
        --output-filename=*) wav="\${arg#--output-filename=}" ;;
    esac
done
cat "${headerPath}" > "$wav"
head -c 32000 /dev/zero >> "$wav"
echo 'wrote it, then died' >&2
exit 1
`)

const packs = getPacks()
const kokoroPack = packs.find(p => p.id === 'kokoro')
const supertonicPack = packs.find(p => p.id === 'supertonic')
const piperPack = packs.find(p => p.id === 'piper')

// --- argv construction is a pure function of the pack ---

const wavPath = GLib.build_filenamev([tmp, 'out.wav'])
const kokoroArgs = [
    `--kokoro-model=${packDir('kokoro')}/model.int8.onnx`,
    `--kokoro-voices=${packDir('kokoro')}/voices.bin`,
    `--kokoro-tokens=${packDir('kokoro')}/tokens.txt`,
    `--kokoro-lexicon=${packDir('kokoro')}/lexicon-us-en.txt,` +
        `${packDir('kokoro')}/lexicon-gb-en.txt,${packDir('kokoro')}/lexicon-zh.txt`,
    `--kokoro-data-dir=${packDir('kokoro')}/espeak-ng-data`,
    `--kokoro-dict-dir=${packDir('kokoro')}/dict`,
    '--sid=23',
    '--num-threads=2',
    `--output-filename=${wavPath}`,
    '--debug=0',
]
assert(JSON.stringify(buildEngineArgs(kokoroPack, { wavPath }))
        === JSON.stringify(kokoroArgs),
'kokoro argv matches the pinned flag template')

const supertonicArgs = [
    `--supertonic-text-encoder=${packDir('supertonic')}/text_encoder.int8.onnx`,
    `--supertonic-duration-predictor=${packDir('supertonic')}/duration_predictor.int8.onnx`,
    `--supertonic-vector-estimator=${packDir('supertonic')}/vector_estimator.int8.onnx`,
    `--supertonic-vocoder=${packDir('supertonic')}/vocoder.int8.onnx`,
    `--supertonic-tts-json=${packDir('supertonic')}/tts.json`,
    `--supertonic-unicode-indexer=${packDir('supertonic')}/unicode_indexer.bin`,
    `--supertonic-voice-style=${packDir('supertonic')}/voice.bin`,
    '--sid=0',
    '--lang=en',
    '--num-threads=2',
    `--output-filename=${wavPath}`,
    '--debug=0',
]
assert(JSON.stringify(buildEngineArgs(supertonicPack, { wavPath }))
        === JSON.stringify(supertonicArgs),
'supertonic argv matches the pinned flag template')
assert(JSON.stringify(buildEngineArgs(supertonicPack,
    { wavPath, lang: 'fr' }))
        === JSON.stringify(supertonicArgs.map(arg =>
            arg === '--lang=en' ? '--lang=fr' : arg)),
'supertonic lang overrides the --lang flag')
assert(!buildEngineArgs(kokoroPack, { wavPath }).some(
    arg => arg.startsWith('--lang')),
'kokoro takes no --lang flag')
assert(!buildEngineArgs(piperPack, { wavPath }).some(
    arg => arg.startsWith('--lang')),
'piper takes no --lang flag')

const piperArgs = [
    `--vits-model=${packDir('piper')}/en_US-amy-low.onnx`,
    `--vits-tokens=${packDir('piper')}/tokens.txt`,
    `--vits-data-dir=${packDir('piper')}/espeak-ng-data`,
    '--sid=0',
    '--num-threads=2',
    `--output-filename=${wavPath}`,
    '--debug=0',
]
assert(JSON.stringify(buildEngineArgs(piperPack, { wavPath }))
        === JSON.stringify(piperArgs),
'piper argv matches the pinned flag template')

try {
    buildEngineArgs({ id: 'not-a-pack' }, { wavPath })
    failures++
    printerr('FAIL: buildEngineArgs on an unknown pack id should throw')
} catch (error) {
    assert(error instanceof Error && /unknown pack/i.test(error.message),
        `unknown pack id throws a clean error (got: ${error.message})`)
}

// --- synth against a fake engine that writes a real wav ---

GLib.setenv('FOLIATE_TTS_CMD', writer, true)
const cacheA = GLib.build_filenamev([tmp, 'cache-a'])
const tts = new LocalTTS({ cacheDir: cacheA })

// miss: engine runs, wav lands, duration matches the known fixture header
const first = await tts.synth('Hello world.', kokoroPack)
assert(runCount() === 1, 'cache miss runs the engine once')
assert(GLib.file_test(first.wavPath, GLib.FileTest.IS_REGULAR),
    'synth produced a wav file')
assert(fileSize(first.wavPath) === 32044,
    'the fake wav is the full known size')
assert(Math.abs(first.duration - expectedDuration) < 1e-9,
    `duration parsed from the wav header (got ${first.duration})`)

// the argv the engine saw: the pinned flags, then exactly one positional
const args = argsLast()
assert(JSON.stringify(args.slice(0, -3))
        === JSON.stringify(kokoroArgs.slice(0, -2)),
'engine argv carries the pack flags in order')
assert(args[args.length - 3].startsWith('--output-filename='),
    '--output-filename comes right before --debug=0')
assert(args[args.length - 2] === '--debug=0', '--debug=0 is the last flag')
assert(args[args.length - 1] === 'Hello world.',
    'the text is the one positional arg')
assert(args.filter(arg => !arg.startsWith('--')).length === 1,
    'exactly one positional text arg')
assert(args.some(arg => arg === '--sid=23'), 'pack sid passes through')
assert(args.some(arg => arg === `--output-filename=${first.wavPath}.part`),
    'the engine stages at <hash>.wav.part, not the cache-visible path')

// hit: same inputs resolve from the cache without running the engine
const second = await tts.synth('Hello world.', kokoroPack)
assert(second.wavPath === first.wavPath, 'cache hit returns the same wav')
assert(second.duration === first.duration,
    'cache hit parses the same duration')
assert(runCount() === 1, 'cache hit does not run the engine')

// different text: a new hash, a new engine run
await tts.synth('Second sentence.', kokoroPack)
assert(runCount() === 2, 'different text is a cache miss')

// sid override: visible on the command line, distinct cache entry
await tts.synth('Hello world.', kokoroPack, { sid: 7 })
assert(argsLast().some(arg => arg === '--sid=7'),
    'sid override passes through to the engine')
assert(runCount() === 3, 'sid override changes the cache key')

// lang is only plumbed for supertonic
await tts.synth('Hello world.', supertonicPack, { lang: 'de' })
const supertonicArgsSeen = argsLast()
assert(supertonicArgsSeen.some(arg => arg === '--lang=de'),
    'lang override reaches the supertonic flags')
assert(supertonicArgsSeen.some(arg => arg === '--sid=0'),
    'supertonic default sid passes through')
assert(runCount() === 4, 'supertonic synth ran the engine')

// default cache dir: <XDG_CACHE_HOME>/foliate/tts-wav. gjs warms
// g_get_user_cache_dir() at process startup (its module bytecode cache),
// so XDG_CACHE_HOME set via GLib.setenv after that cannot repoint it
// in-process — assert against the same GLib resolution the module uses.
const defaultTTS = new LocalTTS()
const defaultWav = (await defaultTTS.synth('Hello world.', piperPack)).wavPath
assert(defaultWav.startsWith(GLib.get_user_cache_dir()) &&
    defaultWav.includes('/foliate/tts-wav/'),
`default cache dir is <XDG_CACHE_HOME>/foliate/tts-wav (got ${defaultWav})`)
assert(runCount() === 5, 'piper synth ran the engine')
// the default-path probe wrote into the real user cache: remove it again
Gio.File.new_for_path(defaultWav).delete(null)

// unknown pack id is rejected before anything is spawned
try {
    await tts.synth('Hello world.', { id: 'not-a-pack', sid: 0 })
    failures++
    printerr('FAIL: synth with an unknown pack id should reject')
} catch (error) {
    assert(/unknown pack/i.test(error.message),
        `unknown pack id rejects with a clean error (got: ${error.message})`)
}

// dev path without FOLIATE_TTS_CMD: the real engine is not on this
// machine, so synth must report the missing engine instead of hanging
GLib.unsetenv('FOLIATE_TTS_CMD')
if (!GLib.find_program_in_path('sherpa-onnx-offline-tts')) {
    try {
        await tts.synth('Never before spoken.', kokoroPack)
        failures++
        printerr('FAIL: synth without an engine should reject')
    } catch (error) {
        assert(/engine not found/i.test(error.message),
            `missing engine reports a clean error (got: ${error.message})`)
    }
}
GLib.setenv('FOLIATE_TTS_CMD', writer, true)

// --- engine failures surface stderr with the exit status ---

GLib.setenv('FOLIATE_TTS_CMD', failing, true)
try {
    await tts.synth('Unheard sentence.', kokoroPack)
    failures++
    printerr('FAIL: a failing engine should reject')
} catch (error) {
    assert(/engine exploded/.test(error.message),
        `stderr reaches the error message (got: ${error.message})`)
    assert(/3/.test(error.message),
        `nonzero exit status reaches the error message (got: ${error.message})`)
}

// --- a crash AFTER the wav is written must not look like a cache hit ---

GLib.setenv('FOLIATE_TTS_CMD', crashesAfterWrite, true)
try {
    await tts.synth('Crash after write.', kokoroPack)
    failures++
    printerr('FAIL: an engine that crashes after writing should reject')
} catch (error) {
    assert(/synthesis failed/.test(error.message) && /died/.test(error.message),
        `crash-after-write rejects with the engine noise (got: ${error.message})`)
}
const crashPart = argsLast()
    .find(arg => arg.startsWith('--output-filename='))
    ?.slice('--output-filename='.length)
assert(crashPart, 'the crashed engine was invoked with an output path')
assert(!GLib.file_test(crashPart, GLib.FileTest.EXISTS),
    'a crashed engine leaves no .part staging file behind')
assert(!GLib.file_test(crashPart.replace(/\.part$/, ''), GLib.FileTest.EXISTS),
    'a crashed engine leaves no cache-visible wav behind')
GLib.setenv('FOLIATE_TTS_CMD', writer, true)

// --- one live synth at a time, killed on cancel and on stop ---

GLib.setenv('FOLIATE_TTS_CMD', sleeper, true)
const cacheB = GLib.build_filenamev([tmp, 'cache-b'])
const slowTTS = new LocalTTS({ cacheDir: cacheB })

// a fresh marker per run: waitFor(EXISTS) must not see the previous
// run's marker before the new engine has even started
const clearPidMarker = () => {
    try {
        Gio.File.new_for_path(pidMarker()).delete(null)
    } catch { /* no marker to clear */ }
}

// kill on cancel: the wait rejects, the subprocess is force-exited and
// reaped, and no orphan process is left behind
{
    const cancellable = new Gio.Cancellable()
    let slowError = null
    clearPidMarker()
    const slow = slowTTS.synth('Hello world.', kokoroPack,
        { cancellable }).catch(error => (slowError = error))
    assert(await waitFor(() =>
        GLib.file_test(pidMarker(), GLib.FileTest.EXISTS)),
    'the fake engine started before the cancel')
    const pid = parseInt(readText(pidMarker()))
    cancellable.cancel()
    await slow
    assert(slowError && /cancel|stopped/i.test(slowError.message),
        `cancelled synth rejects with a cancel error (got: ${slowError?.message})`)
    assert(await waitFor(() => !pidAlive(pid)),
        'cancelled synth leaves no orphan process')
}

// concurrent synth is rejected while one is running
{
    let concurrentError = null
    clearPidMarker()
    const running = slowTTS.synth('Another sentence.', kokoroPack)
        .catch(error => (concurrentError = error))
    assert(await waitFor(() =>
        GLib.file_test(pidMarker(), GLib.FileTest.EXISTS)),
    'the second fake engine run started')
    try {
        await slowTTS.synth('Hello world.', kokoroPack)
        failures++
        printerr('FAIL: a concurrent synth should be rejected')
    } catch (error) {
        assert(/in progress|already/i.test(error.message),
            `concurrent synth rejects with a clean error (got: ${error.message})`)
    }
    await slowTTS.stopAll()
    await running
    assert(/stopped/i.test(concurrentError?.message ?? ''),
        `stopped synth rejects with a stop error (got: ${concurrentError?.message})`)
}

// stopAll: force-exit and reap, no orphans
{
    let stoppedError = null
    clearPidMarker()
    const stopped = slowTTS.synth('To be stopped.', kokoroPack)
        .catch(error => (stoppedError = error))
    assert(await waitFor(() =>
        GLib.file_test(pidMarker(), GLib.FileTest.EXISTS)),
    'the third fake engine run started')
    const pid = parseInt(readText(pidMarker()))
    await slowTTS.stopAll()
    await stopped
    assert(stoppedError && /stopped/i.test(stoppedError.message),
        `stopped synth rejects with a stop error (got: ${stoppedError?.message})`)
    assert(await waitFor(() => !pidAlive(pid)),
        'stopAll leaves no orphan process')
    await slowTTS.stopAll() // a stop with nothing running is a no-op
}

// --- real-engine smoke test (manual, only when the CLI and a real pack
// exist on this machine) ---
// Runs in a child gjs process: GLib caches get_user_data_dir() after the
// first call, so this process (repointed at the temp dir) cannot resolve
// the real pack — a fresh process with the real XDG_DATA_HOME can.
const smokeOut = GLib.build_filenamev([fakeDir, 'smoke.out'])
const smokePath = writeScript('smoke-child.mjs', `import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import { exit } from 'system'
const report = line => GLib.file_set_contents(
    GLib.getenv('SMOKE_OUT'), line)
try {
    const { getPacks, verifyPack } = await import('${srcUri('voice-packs.js')}')
    const { LocalTTS } = await import('${srcUri('local-tts.js')}')
    const pack = getPacks().find(p => p.id === 'kokoro')
    if (!GLib.find_program_in_path('sherpa-onnx-offline-tts'))
        report('MANUAL-SKIPPED: real-engine smoke — sherpa-onnx-offline-tts not in PATH')
    else if (!verifyPack(pack))
        report('MANUAL-SKIPPED: real-engine smoke — kokoro pack not installed')
    else {
        const { wavPath, duration } = await new LocalTTS()
            .synth('Hello world.', pack)
        const size = Gio.File.new_for_path(wavPath).query_info(
            'standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size()
        if (size <= 44 || !(duration > 0))
            throw new Error('bad smoke output: size=' + size +
                ' duration=' + duration)
        report('SMOKE-OK ' + wavPath + ' duration=' + duration)
    }
} catch (error) {
    report('SMOKE-FAIL: ' + error.message)
    exit(1)
}
exit(0)
`)
{
    const gjs = GLib.find_program_in_path('gjs') ?? 'gjs'
    GLib.unsetenv('FOLIATE_TTS_CMD')
    GLib.setenv('XDG_DATA_HOME', realDataHome, true)
    GLib.setenv('SMOKE_OUT', smokeOut, true)
    const proc = Gio.Subprocess.new([gjs, '-m', smokePath],
        Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE)
    GLib.setenv('XDG_DATA_HOME', tmp, true) // the child has its env copy
    GLib.setenv('FOLIATE_TTS_CMD', writer, true)
    GLib.unsetenv('SMOKE_OUT')
    try {
        let smokeOk = true
        try {
            proc.wait_check(null)
        } catch {
            smokeOk = false
        }
        const smoke = readTextOr(smokeOut,
            'SMOKE-FAIL: no smoke report written')
        print(smoke.trim())
        // the smoke wav is a real engine artifact: removed here even when
        // the assertions below fail; a child crash leaves nothing at the
        // cache-visible path (the .part sweep covers its staging file)
        const smokeWav = smoke.startsWith('SMOKE-OK ')
            ? smoke.trim().split(' ')[1] : null
        if (smokeWav) {
            try {
                Gio.File.new_for_path(smokeWav).delete(null)
            } catch { /* already gone */ }
        }
        assert(smokeOk && /SMOKE-OK |MANUAL-SKIPPED:/.test(smoke),
            `real-engine smoke ran or was skipped (got: ${smoke.trim()})`)
    } finally {
        // the child's whole default cache dir is inside the temp XDG tree:
        // sweep it whatever happened
        try {
            Gio.File.new_for_path(
                GLib.build_filenamev([tmp, 'foliate', 'tts-wav']))
                .delete(null)
        } catch { /* nothing to sweep */ }
    }
}

// wait for the killed fake engines' SIGCHLD teardown before checking state
await new Promise(resolve =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50,
        () => (resolve(), GLib.SOURCE_REMOVE)))

if (failures) {
    printerr(`${failures} test${failures > 1 ? 's' : ''} failed`)
    exit(1)
}
print('All tests passed')
