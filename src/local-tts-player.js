import Gio from 'gi://Gio'
import Gst from 'gi://Gst'
import GstPlay from 'gi://GstPlay'

// Sentence-level playback queue on top of a LocalTTS instance: synthesize
// ahead of playback (at most two sentences beyond the one being played,
// executed strictly one at a time because LocalTTS rejects concurrent
// synth), play each wav as it becomes ready, and own the lifecycle of
// the whole run — pause, resume, rate changes, and a stop that stops the
// pipeline, cancels the in-flight synthesis, and reports exactly one
// terminal callback.

// Playback rate bounds, matching the read-aloud UI contract.
const RATE_MIN = 0.75
const RATE_MAX = 2.0
const clampRate = rate => Math.min(RATE_MAX, Math.max(RATE_MIN, rate))

// The error a session rejects with when its stop() is called: the queue
// treats it as an ordinary stop, not a failure.
const STOPPED = 'playback stopped'

// GStreamer must be initialized once per process before any pipeline is
// built; another module may have done it already.
const ensureGst = () => {
    if (!Gst.is_initialized()) Gst.init([])
}

// Default playback backend: one GstPlay pipeline per sentence. The
// returned promise resolves at end-of-stream; pause/resume/stop and
// setRate hang off the promise itself as the small boundary the queue
// drives the active pipeline through, and stop() rejects it with the
// stable stop error above. (The GstPlay typelib ships in GStreamer Bad
// Plugins; playbin would be the fallback if a runtime lacks it.)
const gstreamerPlayWav = (wavPath, { rate } = {}) => {
    ensureGst()
    const play = new GstPlay.Play()
    play.set_uri(Gio.File.new_for_path(wavPath).get_uri())
    // GstPlay reports its own lifecycle through a signal adapter
    const adapter = GstPlay.PlaySignalAdapter.new(play)
    let stopPipeline = null
    const promise = new Promise((resolve, reject) => {
        adapter.connect('end-of-stream', () => resolve())
        adapter.connect('error', (_adapter, error, details) =>
            reject(new Error(['playback failed', error?.message,
                details?.to_string?.()].filter(Boolean).join(': '))))
        stopPipeline = () => {
            play.stop()
            reject(new Error(STOPPED))
        }
    })
    play.play()
    if (rate !== 1) play.set_rate(rate)
    promise.pause = () => play.pause()
    promise.resume = () => play.play()
    promise.stop = () => stopPipeline()
    promise.setRate = rate => play.set_rate(rate)
    return promise
}

export class LocalTTSPlayer {
    #tts
    #makeSession
    #run = null
    #rate = 1
    #paused = false

    constructor({ tts, playWav } = {}) {
        if (!tts)
            throw new Error('LocalTTSPlayer requires a tts instance')
        this.#tts = tts
        // injectable pipeline boundary: tests pass a fake session
        // factory here instead of driving real audio
        this.#makeSession = playWav ?? gstreamerPlayWav
    }

    // Play the sentences (a {text, index} array) in order. onMark fires
    // with the sentence's index when it starts playing; onEnd(null)
    // fires exactly once when every sentence is done or the run was
    // stopped; onError fires instead of onEnd when synthesis or playback
    // fails. Resolves after the terminal callback, so callers may await
    // the whole run.
    async play(sentences, {
        pack, lang, voice, rate = 1, onMark, onEnd, onError,
    } = {}) {
        if (this.#run)
            throw new Error('a playback is already in progress')
        const run = {
            session: null,
            dead: false,
            cancellable: new Gio.Cancellable(),
        }
        this.#run = run
        this.#rate = clampRate(rate)

        // a failed synth halts the whole queue: later chain entries must
        // see it before they call the engine again, so it is tracked on
        // the run rather than discovered through the awaited outcome
        // (whose microtask may run after the next entry has started)
        let failed = false
        let failure = null
        let playIndex = -1 // sentence currently (last) being played
        let queued = -1 // highest index with a chain entry created
        const entries = new Map() // index -> chain promise
        let chain = Promise.resolve()

        // one chain entry per sentence; entries run strictly one at a
        // time (LocalTTS rejects concurrent synth) and each settles to
        // either its result, its error, or an abandoned marker
        const synth = index => {
            if (entries.has(index)) return
            const entry = chain.then(async () => {
                if (run.dead || failed) return { stopped: true }
                try {
                    const result = await this.#tts.synth(
                        sentences[index]?.text, pack, {
                            lang,
                            sid: voice ?? undefined,
                            cancellable: run.cancellable,
                        })
                    return run.dead || failed
                        ? { stopped: true } : { result }
                } catch (error) {
                    failed = true
                    return run.dead ? { stopped: true } : { error }
                }
            })
            entries.set(index, entry)
            chain = entry
        }

        // synth-ahead window of 2: while sentence k plays, at most k+1
        // and k+2 may be synthesizing — kicks happen as playback
        // advances, and the chain above serializes execution, so at most
        // one engine process runs at any moment
        const kick = () => {
            while (queued < Math.min(playIndex + 2, sentences.length - 1))
                synth(++queued)
        }
        kick()

        try {
            for (let i = 0; i < sentences.length; i++) {
                const { result, error, stopped } = await entries.get(i)
                if (stopped) break
                if (error) {
                    run.dead = true
                    throw error
                }
                onMark?.(sentences[i]?.index ?? i)
                playIndex = i
                kick()
                const session = this.#makeSession(result.wavPath, {
                    rate: this.#rate,
                })
                run.session = session
                if (this.#paused) session.pause?.()
                try {
                    await session
                } catch (error) {
                    if (run.dead) break // stopped, not failed
                    run.dead = true
                    throw error
                } finally {
                    if (run.session === session) run.session = null
                }
            }
        } catch (error) {
            failure = error
        } finally {
            // teardown on every exit path: cancel the in-flight synth
            // and reap the engine before reporting, so a stop never
            // leaves pending synthesis behind it
            run.dead = true
            run.cancellable.cancel()
            try {
                await this.#tts.stopAll()
            } catch { /* nothing left to reap */ }
            if (this.#run === run) this.#run = null
            if (failure) onError?.(failure)
            else onEnd?.(null)
        }
    }

    // Hold the current position; a session created while paused starts
    // paused. (GStreamer holds the position across pause/resume.)
    pause() {
        this.#paused = true
        this.#run?.session?.pause?.()
    }

    resume() {
        this.#paused = false
        this.#run?.session?.resume?.()
    }

    // Retune the active pipeline and every sentence played afterwards,
    // clamped to the UI rate range.
    setRate(rate) {
        this.#rate = clampRate(rate)
        this.#run?.session?.setRate?.(this.#rate)
    }

    // Stop the run: pipeline stopped, synth cancelled and reaped, and
    // the unwinding play() reports onEnd(null) exactly once.
    stop() {
        const run = this.#run
        if (!run || run.dead) return
        run.dead = true
        run.session?.stop?.()
        run.cancellable.cancel()
        // not awaited here — the unwinding play() awaits its own
        // stopAll() before reporting, so nothing survives the callback
        this.#tts.stopAll().catch(() => {})
    }
}
