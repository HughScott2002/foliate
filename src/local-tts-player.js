import Gio from 'gi://Gio'
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

// Synth-ahead window bounds: how many sentences beyond the one playing may
// be scheduled (synthesized) at once. Bounded so the queue holds a fixed,
// small number of sentences regardless of book length.
const AHEAD_MIN = 1
const AHEAD_MAX = 16
const AHEAD_DEFAULT = 4
const clampAhead = n => {
    const v = Math.floor(n)
    if (!Number.isFinite(v)) return AHEAD_DEFAULT
    return Math.min(AHEAD_MAX, Math.max(AHEAD_MIN, v))
}

// Invariant checks are always on (TigerStyle): a violated invariant is a
// bug, not a condition to recover from, so it throws.
const invariant = (cond, msg) => {
    if (!cond) throw new Error(`local-tts-player: ${msg}`)
}

// The error a session rejects with when its stop() is called: the queue
// treats it as an ordinary stop, not a failure.
const STOPPED = 'playback stopped'

// GStreamer typelibs load on first use, not on import: a runtime without
// the GstPlay typelib (GStreamer Bad Plugins) fails the individual play
// with a clean error instead of breaking the module — and consumers that
// inject their own playWav never load it at all.
let gstModules = null
const loadGst = async () => {
    if (!gstModules) {
        const [gst, gstPlay] = await Promise.all([
            import('gi://Gst'),
            import('gi://GstPlay'),
        ])
        gstModules = { Gst: gst.default, GstPlay: gstPlay.default }
    }
    return gstModules
}

// Default playback backend: one GstPlay pipeline per sentence. Returns a
// session whose `done` promise resolves at end-of-stream; pause/resume/
// stop and setRate are hooks on the session object, and stop() rejects
// `done` with the stable stop error above.
const gstreamerPlayWav = async (wavPath, { rate } = {}) => {
    const { Gst, GstPlay } = await loadGst()
    // init once per process; another module may have done it already
    if (!Gst.is_initialized()) Gst.init([])
    const play = new GstPlay.Play()
    play.set_uri(Gio.File.new_for_path(wavPath).get_uri())
    // GstPlay reports its own lifecycle through a signal adapter; the
    // adapter must stay alive for the whole session (it owns the bus
    // watch that delivers end-of-stream), so it is captured on the
    // returned session object, which the queue holds until the sentence
    // finishes — a collected adapter would silently drop the watch and
    // the session would never settle
    const adapter = GstPlay.PlaySignalAdapter.new(play)
    let stopPipeline = null
    const done = new Promise((resolve, reject) => {
        adapter.connect('end-of-stream', () => resolve())
        adapter.connect('error', (_adapter, error, details) =>
            reject(new Error(['playback failed', error?.message,
                details?.to_string?.()].filter(Boolean).join(': '))))
        stopPipeline = () => {
            play.stop()
            reject(new Error(STOPPED))
        }
    })
    // the rate is set before play(): setting it afterwards forces a
    // flush seek while prerolling. `|| 1` keeps 0 and undefined from
    // reaching set_rate, which aborts on a zero rate.
    play.set_rate(rate || 1)
    play.play()
    return {
        done,
        adapter,
        pause: () => play.pause(),
        resume: () => play.play(),
        stop: () => stopPipeline(),
        setRate: rate => play.set_rate(rate || 1),
    }
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
        pack, lang, voice, rate, onMark, onEnd, onError,
    } = {}) {
        // a stopped or failed run may still be unwinding (its teardown
        // reaps the engine before reporting): wait for it instead of
        // rejecting, because stop() followed by play() in the same tick
        // is the restart flow. A genuinely live run still rejects.
        while (this.#run) {
            if (!this.#run.dead)
                throw new Error('a playback is already in progress')
            await this.#run.done
        }
        // this run owns the state now: the rate option overrides only
        // when explicitly passed, and a fresh run is never paused — a
        // pause() with nothing playing is not remembered into it (the
        // UI would show playing with no audio sounding)
        this.#rate = clampRate(rate ?? this.#rate)
        this.#paused = false
        let releaseRun
        const run = {
            session: null,
            dead: false,
            cancellable: new Gio.Cancellable(),
            done: new Promise(resolve => { releaseRun = resolve }),
        }
        this.#run = run

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
            while (queued < Math.min(playIndex + 4, sentences.length - 1))
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
                // a stop issued from inside the mark callback must stop
                // the mark's own sentence from playing too
                if (run.dead) break
                playIndex = i
                kick()
                const session = await this.#makeSession(result.wavPath, {
                    rate: this.#rate,
                })
                run.session = session
                if (run.dead) {
                    // a stop landed while the factory was awaiting:
                    // stop the fresh session before it can make a
                    // sound and unwind as a stop
                    session.stop?.()
                    await session.done.catch(() => {})
                    break
                }
                if (this.#paused) session.pause?.()
                try {
                    await session.done
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
            releaseRun()
            if (failure) onError?.(failure)
            else onEnd?.(null)
        }
    }

    // Play a *stream* of sentences: `source()` is an async function that
    // returns the next `{text, index, lang}` or null when the book ends.
    // Unlike play(), the source is pulled AHEAD of playback (up to
    // `synthAhead` sentences beyond the one playing), so the sentences of
    // the next block are fetched and synthesized while the current block
    // is still being read aloud — no synthesis lands on the speaker's
    // critical path at a paragraph or chapter boundary.
    //
    // Bounds (TigerStyle): the window is clamped to [AHEAD_MIN, AHEAD_MAX];
    // `pending`/`entries` hold at most `ahead` sentences at once (each is
    // released once its audio has played); every loop iteration either
    // plays one sentence or ends the stream.
    async playStream(source, {
        pack, voice, rate, synthAhead = AHEAD_DEFAULT, onMark, onEnd, onError,
    } = {}) {
        invariant(typeof source === 'function', 'source must be a function')
        while (this.#run) {
            if (!this.#run.dead)
                throw new Error('a playback is already in progress')
            await this.#run.done
        }
        this.#rate = clampRate(rate ?? this.#rate)
        this.#paused = false
        let releaseRun
        const run = {
            session: null,
            dead: false,
            cancellable: new Gio.Cancellable(),
            done: new Promise(resolve => { releaseRun = resolve }),
        }
        this.#run = run

        const ahead = clampAhead(synthAhead)
        invariant(ahead >= AHEAD_MIN && ahead <= AHEAD_MAX, 'ahead in bounds')

        // Bounded state: at most `ahead` sentences are ever held. Both maps
        // are pruned as each sentence finishes playing.
        const pending = new Map()  // index -> {text, index, lang}
        const entries = new Map()  // index -> synth promise
        let chain = Promise.resolve()
        let scheduled = -1 // highest index handed to the synth chain
        let sourceDone = false
        let failed = false
        let failure = null

        const schedule = index => {
            invariant(!entries.has(index), 'index not scheduled twice')
            const s = pending.get(index)
            invariant(s !== undefined, 'sentence present before scheduling')
            invariant(typeof s.text === 'string', 'sentence text is a string')
            const entry = chain.then(async () => {
                if (run.dead || failed) return { stopped: true }
                try {
                    const result = await this.#tts.synth(s.text, pack, {
                        lang: s.lang,
                        sid: voice ?? undefined,
                        cancellable: run.cancellable,
                    })
                    invariant(result && typeof result.wavPath === 'string',
                        'synth result has a wavPath')
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

        // Pull sentences from the source until `target` is scheduled. Each
        // source() call is one RPC + parse on the reader side. Never
        // schedules beyond the window: `entries.size` stays <= ahead.
        const fill = async target => {
            invariant(target >= 0, 'fill target is non-negative')
            invariant(entries.size <= ahead, 'window not exceeded before fill')
            while (!run.dead && !sourceDone && scheduled < target) {
                const s = await source()
                if (run.dead) return
                if (!s) { sourceDone = true; return }
                invariant(typeof s.text === 'string', 'source sentence has text')
                scheduled += 1
                pending.set(scheduled, s)
                schedule(scheduled)
                invariant(entries.size <= ahead, 'window not exceeded after schedule')
            }
        }

        try {
            let i = 0
            while (!run.dead) {
                invariant(i >= 0, 'playback index non-negative')
                await fill(i + ahead - 1)
                if (run.dead) break
                // fill either produced sentence i or exhausted the source
                invariant(entries.has(i) || sourceDone,
                    'fill produced i or ended the source')
                const entry = entries.get(i)
                if (!entry) break // source exhausted, nothing left to play
                const { result, error, stopped } = await entry
                if (stopped) break
                if (error) {
                    run.dead = true
                    throw error
                }
                onMark?.(pending.get(i) ?? { index: i })
                if (run.dead) break
                const session = await this.#makeSession(result.wavPath, {
                    rate: this.#rate,
                })
                invariant(session && session.done, 'session has a done promise')
                run.session = session
                if (run.dead) {
                    session.stop?.()
                    await session.done.catch(() => {})
                    break
                }
                if (this.#paused) session.pause?.()
                try {
                    await session.done
                } catch (error) {
                    if (run.dead) break // stopped, not failed
                    run.dead = true
                    throw error
                } finally {
                    if (run.session === session) run.session = null
                }
                // release this sentence: its audio is done and no later
                // sentence references it, so memory stays bounded
                pending.delete(i)
                entries.delete(i)
                invariant(pending.size <= ahead - 1, 'released index frees a slot')
                i += 1
            }
        } catch (error) {
            failure = error
        } finally {
            run.dead = true
            run.cancellable.cancel()
            try {
                await this.#tts.stopAll()
            } catch { /* nothing left to reap */ }
            if (this.#run === run) this.#run = null
            releaseRun()
            if (failure) onError?.(failure)
            else onEnd?.(null)
        }
    }

    // Hold the current position; a session created mid-run while paused
    // (in the gap between two sentences) starts paused. (GStreamer holds
    // the position across pause/resume.)
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
