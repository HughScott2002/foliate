import GLib from 'gi://GLib'
import Gio from 'gi://Gio'

import * as voicePacks from './voice-packs.js'
import { buildEngineArgs, parseWavDuration } from './local-tts.js'
import { acquireReadLease, codedError } from './voice-daemon-gate.js'

// Backend readiness for a voice pack. Installation integrity (Task 1's
// getPackState) only proves the files exist and are structurally plausible;
// readiness additionally proves the native engine can load the model and
// synthesize audio. The probe is an isolated CLI subprocess, never the
// shared daemon: a corrupt model can abort the engine's native process, and
// only the disposable probe may pay that cost. The daemon later loads a
// model only after a probe has succeeded.
//
// A successful probe is cached by the required files' identity/change
// metadata, so a changed, removed, or repaired file invalidates it without
// re-reading model contents. Genuine invalid-pack failures are cached the
// same way so a known-bad model is not repeatedly crashed into the engine;
// cancellations, timeouts, and transport failures are never cached and
// never label a structurally valid pack corrupt.

const ENGINE_CMD = 'sherpa-onnx-offline-tts'
const PROBE_TEXT = 'Voice readiness check.'
const PROBE_DIR_TEMPLATE = 'foliate-voice-probe-XXXXXX'
const DIRECTORIES = ['dict', 'espeak-ng-data']

const gioAsync = (object, method, finish, ...args) =>
    new Promise((resolve, reject) => {
        object[method](...args, (source, result) => {
            try {
                resolve(object[finish](result))
            } catch (error) {
                reject(error)
            }
        })
    })

// drain a stream to EOF, returning its bytes as text. stderr is read while
// the probe runs, so a chatty engine can neither block on a full pipe nor
// lose the diagnostic that explains a failed model load.
const drain = stream => new Promise((resolve, reject) => {
    const chunks = []
    const read = () => {
        stream.read_bytes_async(64 * 1024, GLib.PRIORITY_DEFAULT, null,
            (source, result) => {
                try {
                    const bytes = source.read_bytes_finish(result)
                    if (bytes.get_size() === 0)
                        return resolve(new TextDecoder().decode(
                            new Uint8Array(chunks.flatMap(chunk => [...chunk]))))
                    chunks.push(bytes.get_data())
                    read()
                } catch (error) {
                    reject(error)
                }
            })
    }
    read()
})

const engineProgram = () => {
    const cmd = GLib.getenv('FOLIATE_TTS_CMD') ?? ENGINE_CMD
    const program = GLib.find_program_in_path(cmd)
    if (!program)
        throw codedError('engine-missing',
            `TTS engine not found: ${cmd}`)
    return program
}

// Structural state first. Task 1 owns getPackState and its exact semantics;
// when it is not present yet (or for a pack object that bypassed the
// catalog), fall back to the same nonempty structural rules so readiness
// never claims an empty or truncated install is usable.
const structuralState = pack => {
    if (typeof voicePacks.getPackState === 'function') {
        const reported = voicePacks.getPackState(pack)
        if (reported?.status) return reported
    }
    const dir = voicePacks.packDir(pack.id)
    const root = Gio.File.new_for_path(dir)
    if (root.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
        !== Gio.FileType.DIRECTORY)
        return { status: 'missing', message: 'voice pack is not installed' }
    for (const name of pack.expectedFiles ?? []) {
        const file = root.resolve_relative_path(name)
        const type = file.query_file_type(
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
        if (type === Gio.FileType.UNKNOWN)
            return { status: 'invalid', message: `missing ${name}` }
        if (DIRECTORIES.includes(name)) {
            if (type !== Gio.FileType.DIRECTORY)
                return { status: 'invalid', message: `${name} is not a directory` }
            continue
        }
        if (type !== Gio.FileType.REGULAR)
            return { status: 'invalid', message: `${name} is not a regular file` }
        const size = file.query_info('standard::size',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null).get_size()
        if (size === 0)
            return { status: 'invalid', message: `${name} is empty` }
    }
    return { status: 'installed', message: null }
}

// Identity/change metadata for the required files, plus the engine binary
// (a different engine can accept or reject the same model differently).
// Directory entries are fingerprinted with their immediate children too:
// editing a file inside dict/ or espeak-ng-data/ changes no directory
// metadata, so a flat directory stat would keep a stale verdict.
const probeKeyAttrs = 'standard::type,standard::size,time::modified,'
    + 'time::modified-usec,time::changed,time::changed-usec,'
    + 'unix::inode,unix::device'

const identity = info => [info.get_file_type(), info.get_size(),
    info.get_attribute_uint64('time::modified'),
    info.get_attribute_uint32('time::modified-usec'),
    info.get_attribute_uint64('time::changed'),
    info.get_attribute_uint32('time::changed-usec'),
    info.get_attribute_uint64('unix::inode'),
    info.get_attribute_uint32('unix::device')].join(':')

const probeKey = (pack, program) => {
    const dir = voicePacks.packDir(pack.id)
    const parts = [pack.id, program]
    for (const name of pack.expectedFiles ?? []) {
        const info = Gio.File.new_for_path(GLib.build_filenamev([dir, name]))
            .query_info(probeKeyAttrs,
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
        parts.push([name, identity(info)].join(':'))
        if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue
        const entries = []
        const enumerator = Gio.File
            .new_for_path(GLib.build_filenamev([dir, name]))
            .enumerate_children(probeKeyAttrs,
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
        let child
        while ((child = enumerator.next_file(null)) !== null)
            entries.push([child.get_name(), identity(child)])
        enumerator.close(null)
        entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        parts.push(`${name}=${GLib.compute_checksum_for_string(
            GLib.ChecksumType.SHA256,
            entries.map(entry => entry.join(':')).join('\n'), -1)}`)
    }
    return `${pack.id}\0${GLib.compute_checksum_for_string(
        GLib.ChecksumType.SHA256, parts.join('\n'), -1)}`
}

// key -> { ok: true } or { ok: false, message }. Only completed probes are
// cached; cancellation and transport failures leave no entry.
const probeCache = new Map()

export const clearProbeCache = () => probeCache.clear()

const forgetPack = pack => {
    for (const key of probeCache.keys())
        if (key.startsWith(`${pack.id}\0`)) probeCache.delete(key)
}

const rememberPack = (pack, key, value) => {
    for (const existing of probeCache.keys())
        if (existing.startsWith(`${pack.id}\0`) && existing !== key)
            probeCache.delete(existing)
    probeCache.set(key, value)
}

const invalidPack = message => codedError('invalid-pack', message)

const trimmed = (text, limit = 600) => {
    const line = String(text ?? '').trim()
    return line.length > limit ? `${line.slice(0, limit)}…` : line
}

// Run the isolated CLI probe: build the same argv as a real synthesis, let
// the engine write one sample wav into a scratch directory we own, validate
// the wav, and delete the directory on every exit path. The probe process
// owns any native abort; this process only observes its exit status.
const runProbe = async (pack, program, cancellable) => {
    const dir = GLib.dir_make_tmp(PROBE_DIR_TEMPLATE)
    const wavPath = GLib.build_filenamev([dir, 'probe.wav'])
    const release = acquireReadLease()
    try {
        if (cancellable?.is_cancelled())
            throw codedError('cancelled', 'voice pack validation stopped')
        const argv = [program, ...buildEngineArgs(pack, {
            wavPath, sid: pack.sid, lang: 'en',
        }), PROBE_TEXT]
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_SILENCE |
            Gio.SubprocessFlags.STDERR_PIPE)
        const stderr = drain(proc.get_stderr_pipe())
        try {
            await gioAsync(proc, 'wait_check_async', 'wait_check_finish',
                cancellable)
        } catch (error) {
            proc.force_exit()
            await gioAsync(proc, 'wait_async', 'wait_finish', null)
                .catch(() => { /* already reaped */ })
            let details = ''
            try {
                details = await stderr
            } catch { /* diagnostics are best effort */ }
            if (cancellable?.is_cancelled())
                throw codedError('cancelled', 'voice pack validation stopped')
            const failure = invalidPack(trimmed(
                ['voice pack validation failed', error?.message, details]
                    .filter(Boolean).join(': ')))
            failure.details = details
            throw failure
        }
        let details = ''
        try {
            details = await stderr
        } catch { /* diagnostics are best effort */ }
        let duration = 0
        let size = 0
        try {
            size = Gio.File.new_for_path(wavPath).query_info(
                'standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size()
            duration = parseWavDuration(wavPath)
        } catch { /* reported as unusable below */ }
        if (!(duration > 0) || size <= 44) {
            const failure = invalidPack(trimmed(
                ['voice pack produced no usable audio', details]
                    .filter(Boolean).join(': ')))
            failure.details = details
            throw failure
        }
    } finally {
        try {
            const wav = Gio.File.new_for_path(wavPath)
            if (wav.query_exists(null)) wav.delete(null)
        } catch { /* probe artifact already gone */ }
        try {
            Gio.File.new_for_path(dir).delete(null)
        } catch { /* probe directory already gone */ }
        release()
    }
}

export const ensurePackReady = async (pack, { cancellable = null } = {}) => {
    if (!pack?.id || !Array.isArray(pack.expectedFiles))
        throw invalidPack('voice pack metadata is incomplete')
    const state = structuralState(pack)
    if (state.status !== 'installed') {
        forgetPack(pack)
        throw state.status === 'missing'
            ? codedError('pack-missing', state.message ?? 'voice pack is not installed')
            : invalidPack(state.message ?? 'voice pack is not installed')
    }
    if (cancellable?.is_cancelled())
        throw codedError('cancelled', 'voice pack validation stopped')
    const program = engineProgram()
    const key = probeKey(pack, program)
    const cached = probeCache.get(key)
    if (cached?.ok) return
    if (cached && !cached.ok) throw invalidPack(cached.message)
    try {
        await runProbe(pack, program, cancellable)
    } catch (error) {
        // cache only a completed invalid-model verdict; a cancelled or
        // interrupted probe must be retried, not remembered as corrupt
        if (error?.code === 'invalid-pack')
            rememberPack(pack, key, { ok: false, message: error.message })
        else
            probeCache.delete(key)
        throw error
    }
    rememberPack(pack, key, { ok: true })
}
