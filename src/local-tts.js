import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import { packDir } from './voice-packs.js'
import { getVoiceDaemon } from './voice-daemon.js'

// Local neural TTS engine controller: builds the sherpa-onnx-offline-tts
// command line for a pack, synthesizes one sentence at a time into a
// content-addressed wav cache, and owns the subprocess lifecycle (killed
// and reaped on cancel, stop, and failure). The catalog in voice-packs.js
// stays metadata-only — the engine CLI flag templates live here, keyed by
// pack id.

// Dev path: the engine is resolved from PATH. Bundled/packaged engines are
// a later task; until then FOLIATE_TTS_CMD can override the binary.
const ENGINE_CMD = 'sherpa-onnx-offline-tts'
const NUM_THREADS = 2

// 64 KiB read chunks for draining subprocess pipes
const SIZE_CHUNK = 64 * 1024

// gjs 1.86 does not promise-wrap introspection methods whose callback
// parameter is nullable — same helper as voice-packs.js (kept here rather
// than shared through src/utils.js so this module stays free of GUI
// imports, which the headless test shell does not ship).
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

// drain a stream to EOF, returning the bytes as text (stderr of a synth
// subprocess; read concurrently with the wait so a chatty engine can
// neither deadlock on a full pipe nor lose its diagnostics)
const drain = stream => new Promise((resolve, reject) => {
    const chunks = []
    const decode = chunks => {
        const all = new Uint8Array(
            chunks.reduce((size, chunk) => size + chunk.length, 0))
        let offset = 0
        for (const chunk of chunks) {
            all.set(chunk, offset)
            offset += chunk.length
        }
        return new TextDecoder().decode(all)
    }
    const read = () => {
        stream.read_bytes_async(SIZE_CHUNK, GLib.PRIORITY_DEFAULT, null,
            (source, result) => {
                try {
                    const bytes = source.read_bytes_finish(result)
                    if (bytes.get_size() === 0)
                        return resolve(decode(chunks))
                    chunks.push(bytes.get_data())
                    read()
                } catch (error) {
                    reject(error)
                }
            })
    }
    read()
})

// reap a subprocess exactly once no matter how many callers wait on it:
// stopAll() reaps while the owner of the rejected synth promise reaps too
const reapers = new WeakMap()
const reap = proc => {
    let waiting = reapers.get(proc)
    if (!waiting) {
        waiting = gioAsync(proc, 'wait_async', 'wait_finish', null)
            .catch(() => { /* nothing left to reap */ })
        reapers.set(proc, waiting)
    }
    return waiting
}

// duration in seconds from the RIFF header: data chunk size (bytes 40-44,
// little-endian) over the byte rate (sampleRate * channels * bits / 8) —
// unlike the RIFF size at bytes 4-8 this carries no 44-byte header bias.
// The 'data' tag is validated at its canonical offset (bytes 36-40): a
// non-canonical chunk layout fails loudly instead of returning a
// plausible-looking wrong duration.
export const parseWavDuration = path => {
    const stream = Gio.File.new_for_path(path).read(null)
    try {
        const data = stream.read_bytes(44, null).get_data()
        if (data.length < 44)
            throw new Error(`truncated wav header: ${path}`)
        const view = new DataView(data.buffer, data.byteOffset, data.length)
        if (view.getUint32(0, false) !== 0x52494646) // 'RIFF'
            throw new Error(`not a WAV file: ${path}`)
        if (view.getUint32(36, false) !== 0x64617461) // 'data'
            throw new Error(`unsupported wav layout: ${path}`)
        const byteRate = view.getUint32(24, true) * view.getUint16(22, true) *
            view.getUint16(34, true) / 8
        if (!byteRate)
            throw new Error(`invalid wav header: ${path}`)
        return view.getUint32(40, true) / byteRate
    } finally {
        stream.close(null)
    }
}

// the cache key covers everything the audio depends on: the text, the
// pack, the voice id, and — only where the engine takes it — the language.
// NUL separators keep fields from blurring into each other ('ab'+'c' must
// not hash as 'a'+'bc').
export const cacheKey = (text, id, sid, lang) => GLib.compute_checksum_for_bytes(
    GLib.ChecksumType.SHA256, new GLib.Bytes(
        new TextEncoder().encode(
            `${text}\0${id}\0${sid}${lang ? `\0${lang}` : ''}`)))

// move a completed file into place: same-directory rename, so the engine
// never leaves a partial file at the cache-visible path
const moveFile = (from, to) => Gio.File.new_for_path(from)
    .move(Gio.File.new_for_path(to), Gio.FileCopyFlags.OVERWRITE, null, null)

// CLI flag templates, keyed by pack id: engine-specific flags, then the
// voice id, thread count, output file, and debug flag shared by all packs,
// then exactly one positional text arg (appended by synth()). --sid is
// part of each engine's own flag run: supertonic places --lang after it.
const ENGINE_FLAGS = {
    kokoro: (dir, sid) => [
        `--kokoro-model=${dir}/model.int8.onnx`,
        `--kokoro-voices=${dir}/voices.bin`,
        `--kokoro-tokens=${dir}/tokens.txt`,
        `--kokoro-lexicon=${dir}/lexicon-us-en.txt,` +
            `${dir}/lexicon-gb-en.txt,${dir}/lexicon-zh.txt`,
        `--kokoro-data-dir=${dir}/espeak-ng-data`,
        `--kokoro-dict-dir=${dir}/dict`,
        `--sid=${sid}`,
    ],
    supertonic: (dir, sid, lang) => [
        `--supertonic-text-encoder=${dir}/text_encoder.int8.onnx`,
        `--supertonic-duration-predictor=${dir}/duration_predictor.int8.onnx`,
        `--supertonic-vector-estimator=${dir}/vector_estimator.int8.onnx`,
        `--supertonic-vocoder=${dir}/vocoder.int8.onnx`,
        `--supertonic-tts-json=${dir}/tts.json`,
        `--supertonic-unicode-indexer=${dir}/unicode_indexer.bin`,
        `--supertonic-voice-style=${dir}/voice.bin`,
        `--sid=${sid}`,
        `--lang=${lang}`,
    ],
    piper: (dir, sid) => [
        `--vits-model=${dir}/en_US-amy-low.onnx`,
        `--vits-tokens=${dir}/tokens.txt`,
        `--vits-data-dir=${dir}/espeak-ng-data`,
        `--sid=${sid}`,
    ],
}

// Pure argv builder: flags reference packDir(pack.id) paths, resolved to
// absolute. lang is only used by supertonic (default 'en').
export const buildEngineArgs = (pack, { wavPath, lang, sid } = {}) => {
    const build = ENGINE_FLAGS[pack?.id]
    if (!build)
        throw new Error(`unknown pack id: ${pack?.id}`)
    const sidUsed = sid ?? pack.sid
    return [
        ...build(packDir(pack.id), sidUsed, lang ?? 'en'),
        `--num-threads=${NUM_THREADS}`,
        `--output-filename=${wavPath}`,
        '--debug=0',
    ]
}

export class LocalTTS {
    #cacheDir
    #proc = null
    #stoppedProc = null

    constructor({ cacheDir } = {}) {
        this.#cacheDir = cacheDir ?? GLib.build_filenamev(
            [GLib.get_user_cache_dir(), 'foliate', 'tts-wav'])
    }

    // Synthesize one sentence into the wav cache and return
    // {wavPath, duration}. Concurrent calls that would spawn are rejected
    // (Task 4 builds the playback queue on top); cache hits return
    // immediately since they spawn nothing.
    async synth(text, pack, { lang, sid, cancellable = null } = {}) {
        // effective overrides: the sid option stands in for pack.sid; the
        // lang option only reaches the engine on supertonic packs, so it
        // keys the cache only there and a UI language switch cannot fork
        // kokoro/piper cache entries for identical audio
        const langUsed = lang ?? 'en'
        const keyLang = pack.id === 'supertonic' ? langUsed : null
        const sidUsed = sid ?? pack.sid
        const wavPath = GLib.build_filenamev([this.#cacheDir, `${cacheKey(
            text, pack.id, sidUsed, keyLang)}.wav`])
        if (GLib.file_test(wavPath, GLib.FileTest.IS_REGULAR))
            return { wavPath, duration: parseWavDuration(wavPath) }
        // the foliate-voice daemon keeps models loaded; prefer it when up
        // and fall back to the one-shot CLI engine if it is not (or failed)
        const daemon = getVoiceDaemon()
        if (daemon.running && !this.#proc) {
            // the cache dir may not exist yet on a fresh session; the
            // daemon writes the wav at partPath and will not create it
            GLib.mkdir_with_parents(this.#cacheDir, 0o755)
            const partPath = `${wavPath}.part`
            const partFile = Gio.File.new_for_path(partPath)
            try {
                const duration = await daemon.synth(text, partPath, pack,
                    { lang: langUsed, cancellable })
                moveFile(partPath, wavPath)
                return { wavPath, duration }
            } catch (e) {
                try { partFile.delete(null) } catch { /* nothing staged */ }
                if (cancellable?.is_cancelled()) throw new Error('synthesis stopped')
                console.warn(`voice daemon synthesis failed, using CLI engine: ${e.message}`)
            }
        }
        if (this.#proc)
            throw new Error('a synthesis is already in progress')
        const cmd = GLib.getenv('FOLIATE_TTS_CMD') ?? ENGINE_CMD
        const program = GLib.find_program_in_path(cmd)
        if (!program)
            throw new Error(`TTS engine not found: ${cmd}`)
        // stage the output at <hash>.wav.part: the engine writes the file
        // incrementally, so a killed or crashed run would otherwise leave
        // a partial wav at the cache-visible path and every later call
        // would treat it as a cache hit (playing silence). The .part file
        // is renamed onto the final path only after a clean exit.
        const partPath = `${wavPath}.part`
        const partFile = Gio.File.new_for_path(partPath)
        const argv = [program, ...buildEngineArgs(pack,
            { wavPath: partPath, sid: sidUsed, lang: langUsed }), text]
        GLib.mkdir_with_parents(this.#cacheDir, 0o755)
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_SILENCE |
            Gio.SubprocessFlags.STDERR_PIPE)
        this.#proc = proc
        try {
            const stderrPromise = drain(proc.get_stderr_pipe())
            try {
                await gioAsync(proc, 'wait_check_async', 'wait_check_finish',
                    cancellable)
            } catch (error) {
                // cancelled or died: force-exit and reap before reporting,
                // so nothing is left running behind the rejected promise,
                // and no partial .part file survives for later calls to
                // mistake for a cache hit
                proc.force_exit()
                await reap(proc)
                let stderr = null
                try {
                    stderr = await stderrPromise
                } catch (drainError) {
                    // a drain rejection must not skip the .part cleanup:
                    // capture it into the report instead
                    stderr = `stderr unreadable: ${drainError?.message ??
                        drainError}`
                } finally {
                    try {
                        partFile.delete(null)
                    } catch { /* nothing staged */ }
                }
                if (this.#stoppedProc === proc)
                    throw new Error('synthesis stopped')
                throw new Error(['synthesis failed', error.message,
                    stderr].filter(Boolean).join(': '))
            }
            // clean exit: drain stderr (a drain rejection must not skip
            // cleanup), then validate BEFORE publishing — a truncated
            // exit-0 file must never land at the cache-visible path
            let published = false
            try {
                const stderr = await stderrPromise
                if (!GLib.file_test(partPath, GLib.FileTest.IS_REGULAR))
                    throw new Error(['engine wrote no output', program,
                        stderr].filter(Boolean).join(': '))
                // parse before publishing: a file that fails wav
                // validation is deleted with the staging path, so no
                // poisoned entry is ever visible to cache hits
                const duration = parseWavDuration(partPath)
                moveFile(partPath, wavPath)
                published = true
                return { wavPath, duration }
            } finally {
                // nothing staged survives a failure; after a successful
                // move the delete is a harmless no-op
                if (!published)
                    try { partFile.delete(null) } catch {
                        /* nothing staged */
                    }
            }
        } finally {
            if (this.#proc === proc) this.#proc = null
            // the stopped identity was consumed by the failure path above;
            // clear it here so it cannot pin the proc and its stderr fd
            if (this.#stoppedProc === proc) this.#stoppedProc = null
        }
    }

    // Force-exit any live synth subprocess and wait for it to be reaped,
    // so a stopped synthesis never leaves an orphaned engine behind.
    // The stopped process is tracked (not a boolean flag) so a later
    // synth started after stopAll() resolves can never be misreported
    // as stopped by the still-unwinding previous frame.
    async stopAll() {
        const proc = this.#proc
        if (!proc) return
        this.#stoppedProc = proc
        proc.force_exit()
        await reap(proc)
        if (this.#proc === proc) this.#proc = null
    }
}
