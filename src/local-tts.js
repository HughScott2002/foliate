import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import { packDir } from './voice-packs.js'

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

// duration in seconds from the RIFF header: riff size (file size - 8,
// bytes 4-8 little-endian) over the byte rate (sampleRate * channels *
// bits / 8)
const parseWavDuration = path => {
    const stream = Gio.File.new_for_path(path).read(null)
    try {
        const data = stream.read_bytes(44, null).get_data()
        if (data.length < 44)
            throw new Error(`truncated wav header: ${path}`)
        const view = new DataView(data.buffer, data.byteOffset, data.length)
        if (view.getUint32(0, false) !== 0x52494646) // 'RIFF'
            throw new Error(`not a WAV file: ${path}`)
        const byteRate = view.getUint32(24, true) * view.getUint16(22, true) *
            view.getUint16(34, true) / 8
        if (!byteRate)
            throw new Error(`invalid wav header: ${path}`)
        return view.getUint32(4, true) / byteRate
    } finally {
        stream.close(null)
    }
}

// the cache key covers everything the audio depends on: the text, the
// pack, the voice id, and the language. NUL separators keep fields from
// blurring into each other ('ab'+'c' must not hash as 'a'+'bc').
const cacheKey = (text, id, sid, lang) => GLib.compute_checksum_for_bytes(
    GLib.ChecksumType.SHA256, new GLib.Bytes(
        new TextEncoder().encode(`${text}\0${id}\0${sid}\0${lang}`)))

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
export const buildEngineArgs = (pack, { wavPath, lang } = {}) => {
    const build = ENGINE_FLAGS[pack?.id]
    if (!build)
        throw new Error(`unknown pack id: ${pack?.id}`)
    return [
        ...build(packDir(pack.id), pack.sid, lang ?? 'en'),
        `--num-threads=${NUM_THREADS}`,
        `--output-filename=${wavPath}`,
        '--debug=0',
    ]
}

export class LocalTTS {
    #cacheDir
    #proc = null
    #stopped = false

    constructor({ cacheDir } = {}) {
        this.#cacheDir = cacheDir ?? GLib.build_filenamev(
            [GLib.get_user_cache_dir(), 'foliate', 'tts-wav'])
    }

    // Synthesize one sentence into the wav cache and return
    // {wavPath, duration}. Concurrent calls that would spawn are rejected
    // (Task 4 builds the playback queue on top); cache hits return
    // immediately since they spawn nothing.
    async synth(text, pack, { lang, sid, cancellable = null } = {}) {
        // effective overrides: the sid option stands in for pack.sid, the
        // lang option only reaches the engine on supertonic packs
        const langUsed = lang ?? 'en'
        const sidUsed = sid ?? pack.sid
        const wavPath = GLib.build_filenamev([this.#cacheDir, `${cacheKey(
            text, pack.id, sidUsed, langUsed)}.wav`])
        if (GLib.file_test(wavPath, GLib.FileTest.IS_REGULAR))
            return { wavPath, duration: parseWavDuration(wavPath) }
        if (this.#proc)
            throw new Error('a synthesis is already in progress')
        const cmd = GLib.getenv('FOLIATE_TTS_CMD') ?? ENGINE_CMD
        const program = GLib.find_program_in_path(cmd)
        if (!program)
            throw new Error(`TTS engine not found: ${cmd}`)
        const argv = [program, ...buildEngineArgs(
            sid == null ? pack : { ...pack, sid: sidUsed },
            { wavPath, lang: langUsed }), text]
        GLib.mkdir_with_parents(this.#cacheDir, parseInt('0755', 8))
        const proc = Gio.Subprocess.new(argv,
            Gio.SubprocessFlags.STDOUT_SILENCE |
            Gio.SubprocessFlags.STDERR_PIPE)
        this.#proc = proc
        this.#stopped = false
        try {
            const stderrPromise = drain(proc.get_stderr_pipe())
            try {
                await gioAsync(proc, 'wait_check_async', 'wait_check_finish',
                    cancellable)
            } catch (error) {
                // cancelled or died: force-exit and reap before reporting,
                // so nothing is left running behind the rejected promise
                proc.force_exit()
                await reap(proc)
                const stderr = await stderrPromise
                if (this.#stopped)
                    throw new Error('synthesis stopped')
                throw new Error(['synthesis failed', error.message,
                    stderr].filter(Boolean).join(': '))
            }
            // success still drains stderr so the pipe fd is closed
            const stderr = await stderrPromise
            if (!GLib.file_test(wavPath, GLib.FileTest.IS_REGULAR))
                throw new Error(['engine wrote no output', program, stderr]
                    .filter(Boolean).join(': '))
            return { wavPath, duration: parseWavDuration(wavPath) }
        } finally {
            if (this.#proc === proc) this.#proc = null
        }
    }

    // Force-exit any live synth subprocess and wait for it to be reaped,
    // so a stopped synthesis never leaves an orphaned engine behind.
    async stopAll() {
        const proc = this.#proc
        if (!proc) return
        this.#stopped = true
        proc.force_exit()
        await reap(proc)
        if (this.#proc === proc) this.#proc = null
    }
}
