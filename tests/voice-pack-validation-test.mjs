import { exit } from 'system'
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'

// Isolation first: probes and the fake engine live entirely in this tree.
const tmp = GLib.dir_make_tmp('foliate-validation-XXXXXX')
GLib.setenv('XDG_DATA_HOME', tmp, true)
GLib.setenv('XDG_CACHE_HOME', tmp, true)
GLib.setenv('XDG_CONFIG_HOME', tmp, true)

const { getPacks, packDir } = await import('../src/voice-packs.js')
const {
    ensurePackReady, clearProbeCache,
} = await import('../src/voice-pack-validation.js')
const { LocalTTS } = await import('../src/local-tts.js')

let failures = 0
const assert = (cond, msg) => {
    if (cond) return
    failures++
    printerr(`FAIL: ${msg}`)
}
const tick = ms => new Promise(resolve =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
        () => (resolve(), GLib.SOURCE_REMOVE)))
const waitFor = async (cond, ms = 5000) => {
    const deadline = Date.now() + ms
    while (!cond()) {
        if (Date.now() > deadline) return false
        await tick(20)
    }
    return true
}
const readTextOr = (path, fallback) =>
    GLib.file_test(path, GLib.FileTest.EXISTS)
        ? new TextDecoder().decode(Gio.File.new_for_path(path)
            .load_contents(null)[1]) : fallback
const pidAlive = pid => GLib.file_test(`/proc/${pid}`, GLib.FileTest.EXISTS)

// Rejection helper: returns the error so callers can assert its code.
const rejection = async (promise, label) => {
    try {
        await promise
    } catch (error) {
        return error
    }
    failures++
    printerr(`FAIL: ${label} should have rejected`)
    return null
}

// --- fixtures: a nonempty piper pack plus fake engines ---

const fakeDir = GLib.build_filenamev([tmp, 'fake'])
GLib.mkdir_with_parents(fakeDir, 0o755)
const runsFile = GLib.build_filenamev([fakeDir, 'runs'])
const runCount = () => readTextOr(runsFile, '').split('\n')
    .filter(Boolean).length
const pidFile = GLib.build_filenamev([fakeDir, 'pid'])

const writeScript = (name, content) => {
    const path = GLib.build_filenamev([fakeDir, name])
    Gio.File.new_for_path(path).replace_contents(content, null, false,
        Gio.FileCreateFlags.NONE, null)
    Gio.File.new_for_path(path).set_attribute_uint32(
        Gio.FILE_ATTRIBUTE_UNIX_MODE, 0o755,
        Gio.FileQueryInfoFlags.NONE, null)
    return path
}

const headerPath = GLib.build_filenamev([fakeDir, 'header.bin'])
{
    const buf = new ArrayBuffer(44)
    const view = new DataView(buf)
    const put = (offset, str) => {
        for (let i = 0; i < str.length; i++)
            view.setUint8(offset + i, str.charCodeAt(i))
    }
    put(0, 'RIFF')
    view.setUint32(4, 36 + 32000, true)
    put(8, 'WAVE')
    put(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 16000, true)
    view.setUint32(28, 32000, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    put(36, 'data')
    view.setUint32(40, 32000, true)
    const file = Gio.File.new_for_path(headerPath)
        .replace(null, false, Gio.FileCreateFlags.NONE, null)
    file.write_bytes(new GLib.Bytes(new Uint8Array(buf)), null)
    file.close(null)
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
cat "$dir/header.bin" > "$wav"
head -c 32000 /dev/zero >> "$wav"
echo x >> "$dir/runs"
`)
const failing = writeScript('fake-failing.sh', `#!/bin/sh
echo 'engine exploded' >&2
exit 3
`)
// failing engine that also counts probes, for cache-invalidation regressions
const failingCounted = writeScript('fake-failing-counted.sh', `#!/bin/sh
echo 'engine exploded' >&2
echo x >> "$(dirname "$0")/runs"
exit 3
`)
const garbage = writeScript('fake-garbage.sh', `#!/bin/sh
for arg; do
    case "$arg" in
        --output-filename=*) wav="\${arg#--output-filename=}" ;;
    esac
done
echo 'not a wav' > "$wav"
exit 0
`)
const aborting = writeScript('fake-abort.sh', `#!/bin/sh
kill -6 $$
`)
const sleeper = writeScript('fake-sleeper.sh', `#!/bin/sh
echo $$ > "${pidFile}"
exec sleep 30
`)

// Replace a file's contents while preserving its byte size and mtime, so a
// same-size/same-mtime replacement changes only ctime/inode identity. Used by
// the cache-invalidation regressions below.
const replacePreservingMtime = (path, content) => {
    const original = Gio.File.new_for_path(path).query_info(
        'standard::size,time::modified,time::modified-usec',
        Gio.FileQueryInfoFlags.NONE, null)
    const tmpPath = `${path}.replacement`
    GLib.file_set_contents(tmpPath, content)
    const touch = Gio.Subprocess.new(['touch', '-r', path, tmpPath],
        Gio.SubprocessFlags.NONE)
    touch.wait_check(null)
    Gio.File.new_for_path(tmpPath).move(Gio.File.new_for_path(path),
        Gio.FileCopyFlags.OVERWRITE, null, null)
    const after = Gio.File.new_for_path(path).query_info(
        'standard::size,time::modified,time::modified-usec',
        Gio.FileQueryInfoFlags.NONE, null)
    return after.get_size() === original.get_size() &&
        after.get_attribute_uint64('time::modified')
            === original.get_attribute_uint64('time::modified') &&
        after.get_attribute_uint32('time::modified-usec')
            === original.get_attribute_uint32('time::modified-usec')
}

const piper = getPacks().find(p => p.id === 'piper')
const piperDir = packDir('piper')
GLib.mkdir_with_parents(`${piperDir}/espeak-ng-data`, 0o700)
const modelPath = `${piperDir}/en_US-amy-low.onnx`
const tokensPath = `${piperDir}/tokens.txt`
GLib.file_set_contents(modelPath, 'x')
GLib.file_set_contents(tokensPath, 'x')
clearProbeCache()

// --- a missing engine is transport, not corruption ---

GLib.setenv('FOLIATE_TTS_CMD', '/nonexistent/foliate-probe-engine', true)
{
    const error = await rejection(ensurePackReady(piper), 'missing engine')
    assert(error?.code === 'engine-missing',
        `missing engine keeps its own code (got: ${error?.code})`)
    assert(error?.code !== 'invalid-pack',
        'a missing executable must not label the pack corrupt')
}

// --- a successful probe caches by file identity/change metadata ---

GLib.setenv('FOLIATE_TTS_CMD', writer, true)
{
    await ensurePackReady(piper)
    assert(runCount() === 1, 'a successful probe runs the isolated engine once')
    await ensurePackReady(piper)
    assert(runCount() === 1, 'an unchanged pack reuses the cached probe')
    // a changed required file invalidates the cache without a daemon
    const append = Gio.File.new_for_path(modelPath).append_to(
        Gio.FileCreateFlags.NONE, null)
    append.write_bytes(new GLib.Bytes(new TextEncoder().encode('y')), null)
    append.close(null)
    await ensurePackReady(piper)
    assert(runCount() === 2, 'a changed model file invalidates the cached probe')
}

// --- empty required files are rejected without spawning the engine ---

{
    GLib.file_set_contents(modelPath, '')
    const error = await rejection(ensurePackReady(piper), 'empty model file')
    assert(error?.code === 'invalid-pack',
        `an empty required file is invalid (got: ${error?.code})`)
    assert(runCount() === 2, 'the structural failure spawns no engine')
    GLib.file_set_contents(modelPath, 'x')
    await ensurePackReady(piper)
    assert(runCount() === 3, 'a repaired nonempty file probes again')
}

// --- a completed invalid-model verdict is remembered ---

GLib.setenv('FOLIATE_TTS_CMD', failing, true)
{
    const first = await rejection(ensurePackReady(piper), 'failing engine')
    assert(first?.code === 'invalid-pack',
        `a failed model load is invalid-pack (got: ${first?.code})`)
    assert(/engine exploded/.test(first?.message ?? ''),
        `probe diagnostics reach the error (got: ${first?.message})`)
    const before = runCount()
    const second = await rejection(ensurePackReady(piper), 'cached failure')
    assert(second?.code === 'invalid-pack', 'the remembered failure rejects')
    assert(runCount() === before,
        'a remembered invalid pack is not crashed into again')
}

// --- malformed audio and a native abort stay inside the probe ---

GLib.setenv('FOLIATE_TTS_CMD', garbage, true)
{
    const error = await rejection(ensurePackReady(piper), 'garbage output')
    assert(error?.code === 'invalid-pack',
        `malformed probe audio is invalid-pack (got: ${error?.code})`)
}
GLib.setenv('FOLIATE_TTS_CMD', aborting, true)
{
    const error = await rejection(ensurePackReady(piper), 'native abort')
    assert(error?.code === 'invalid-pack',
        `a native abort is an invalid pack (got: ${error?.code})`)
    // the parent process is still alive and can still probe successfully
    GLib.setenv('FOLIATE_TTS_CMD', writer, true)
    await ensurePackReady(piper)
    assert(true, 'the test process survived the probe abort')
}

// --- cancellation settles the probe and is never cached as invalid ---

GLib.setenv('FOLIATE_TTS_CMD', sleeper, true)
{
    const cancellable = new Gio.Cancellable()
    const pending = rejection(
        ensurePackReady(piper, { cancellable }), 'cancelled probe')
    assert(await waitFor(() => GLib.file_test(pidFile, GLib.FileTest.EXISTS)),
        'the sleeping probe engine started')
    const pid = parseInt(readTextOr(pidFile, '0'))
    cancellable.cancel()
    const error = await pending
    assert(error?.code === 'cancelled',
        `a cancelled probe reports cancellation (got: ${error?.code})`)
    assert(await waitFor(() => !pidAlive(pid)),
        'the cancelled probe subprocess was reaped')
    GLib.setenv('FOLIATE_TTS_CMD', writer, true)
    await ensurePackReady(piper)
    assert(true, 'cancellation did not poison the readiness cache')
}

// --- a removed required file invalidates the installed pack ---

{
    Gio.File.new_for_path(tokensPath).delete(null)
    const error = await rejection(ensurePackReady(piper), 'removed file')
    assert(error?.code === 'invalid-pack',
        `a removed required file is invalid (got: ${error?.code})`)
    assert(/missing|tokens/i.test(error?.message ?? ''),
        `the removed file is named in the error (got: ${error?.message})`)
    GLib.file_set_contents(tokensPath, 'x')
}

// --- an invalid pack never reaches the shared daemon ---

{
    GLib.setenv('FOLIATE_TTS_CMD', failing, true)
    const fakeDaemon = {
        running: true,
        calls: 0,
        async synth() {
            fakeDaemon.calls += 1
            return 1
        },
        async start() {},
    }
    const tts = new LocalTTS({
        cacheDir: GLib.build_filenamev([tmp, 'cache']),
        daemon: fakeDaemon,
    })
    const error = await rejection(
        tts.synth('Never spoken.', piper), 'invalid pack synthesis')
    assert(error?.code === 'invalid-pack',
        `LocalTTS propagates invalid-pack (got: ${error?.code})`)
    assert(fakeDaemon.calls === 0,
        'the shared daemon is never asked to load an invalid pack')
}

// --- same-size/same-mtime replacement invalidates a cached success ---

{
    GLib.setenv('FOLIATE_TTS_CMD', writer, true)
    GLib.file_set_contents(modelPath, 'x')
    clearProbeCache()
    await ensurePackReady(piper)
    const before = runCount()
    assert(replacePreservingMtime(modelPath, 'z'),
        'the regression replacement preserved size and mtime')
    await ensurePackReady(piper)
    assert(runCount() === before + 1,
        'a same-size/same-mtime replacement re-probes a cached success')
}

// --- same-size/same-mtime replacement invalidates a cached invalid verdict ---

{
    GLib.setenv('FOLIATE_TTS_CMD', failingCounted, true)
    GLib.file_set_contents(modelPath, 'x')
    clearProbeCache()
    const first = await rejection(ensurePackReady(piper), 'counted failing engine')
    assert(first?.code === 'invalid-pack',
        `the counted engine rejects as invalid-pack (got: ${first?.code})`)
    const before = runCount()
    assert(replacePreservingMtime(modelPath, 'z'),
        'the invalid-verdict replacement preserved size and mtime')
    const second = await rejection(ensurePackReady(piper), 'replaced cached invalid')
    assert(second?.code === 'invalid-pack',
        `the replaced model still rejects as invalid-pack (got: ${second?.code})`)
    assert(runCount() === before + 1,
        'a same-size/same-mtime replacement re-probes a cached invalid verdict')
}

// --- an in-place nested edit invalidates a cached success ---

{
    GLib.setenv('FOLIATE_TTS_CMD', writer, true)
    GLib.file_set_contents(modelPath, 'x')
    clearProbeCache()
    const nested = GLib.build_filenamev(
        [piperDir, 'espeak-ng-data', 'data.bin'])
    if (!GLib.file_test(nested, GLib.FileTest.IS_REGULAR))
        GLib.file_set_contents(nested, 'initial')
    await ensurePackReady(piper)
    const before = runCount()
    // Overwrite in place: no size change, no inode replacement, and no
    // directory metadata change, so only child-aware fingerprints see it.
    {
        const handle = Gio.File.new_for_path(nested).open_readwrite(null)
        handle.get_output_stream().write_bytes(
            new GLib.Bytes(new TextEncoder().encode('z')), null)
        handle.close(null)
    }
    await ensurePackReady(piper)
    assert(runCount() === before + 1,
        'an in-place nested file edit re-probes a cached success')
}

// --- an in-place nested edit invalidates a cached invalid verdict ---

{
    GLib.setenv('FOLIATE_TTS_CMD', failingCounted, true)
    GLib.file_set_contents(modelPath, 'x')
    clearProbeCache()
    const nested = GLib.build_filenamev(
        [piperDir, 'espeak-ng-data', 'data.bin'])
    if (!GLib.file_test(nested, GLib.FileTest.IS_REGULAR))
        GLib.file_set_contents(nested, 'initial')
    const first = await rejection(ensurePackReady(piper), 'nested initial failure')
    assert(first?.code === 'invalid-pack',
        `the nested engine rejects as invalid-pack (got: ${first?.code})`)
    const before = runCount()
    {
        const handle = Gio.File.new_for_path(nested).open_readwrite(null)
        handle.get_output_stream().write_bytes(
            new GLib.Bytes(new TextEncoder().encode('z')), null)
        handle.close(null)
    }
    const second = await rejection(ensurePackReady(piper), 'nested cached invalid')
    assert(second?.code === 'invalid-pack',
        `the edited nested file still rejects as invalid-pack (got: ${second?.code})`)
    assert(runCount() === before + 1,
        'an in-place nested file edit re-probes a cached invalid verdict')
}

if (failures) {
    printerr(`${failures} test${failures > 1 ? 's' : ''} failed`)
    exit(1)
}
print('All tests passed')
