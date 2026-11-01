import Gio from 'gi://Gio'
// Sentence-level playback queue on top of a LocalTTS instance: synthesize
// ahead of playback (a small clamped window beyond the one being played,
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
// small number of sentences regardless of book length. The floor is 2, not
// 1: with 1 no sentence is fetched beyond the one playing, so every next
// sentence is synthesized on the critical path — the spec requires the
// sentence after the playing one to already be synthesized.
const AHEAD_MIN = 2
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

// A `source` may return this instead of a sentence or null: the current
// section is exhausted but the book is not. The queue holds at the boundary
// and calls `onSectionEnd` (which pages the renderer) only when playback
// actually reaches it, so lookahead never turns the page early or drops
// state that a still-playing sentence needs.
export const SECTION_END = Symbol('section-end')

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

// Adaptive synth-ahead window. Synthesis (synth ms) versus audio time
// (audio ms) is the real-time factor: below 1, the engine outruns playback
// and the window can grow; above ~0.8 it is struggling and the window
// shrinks so we do not over-buffer. Grows by 2 after 3 fast sentences in a
// row; shrinks by 1 when slow; clamped to [AHEAD_MIN, AHEAD_MAX].
export const adaptWindow = (window, streak, rtf) => {
    if (rtf > 0.8) return { window: Math.max(AHEAD_MIN, window - 1), streak: 0 }
    if (rtf < 0.5) {
        const next = streak + 1
        if (next >= 3) return { window: Math.min(AHEAD_MAX, window + 2), streak: 0 }
        return { window, streak: next }
    }
    return { window, streak: 0 }
}

export class LocalTTSPlayer {
    #tts
    #makeSession
    #synthAhead
    #rtfStreak = 0
    #log
    #run = null
    #rate = 1
    #paused = false

    constructor({ tts, playWav, synthAhead = AHEAD_DEFAULT, log } = {}) {
        if (!tts)
            throw new Error('LocalTTSPlayer requires a tts instance')
        this.#tts = tts
        // injectable pipeline boundary: tests pass a fake session
        // factory here instead of driving real audio
        this.#makeSession = playWav ?? gstreamerPlayWav
        this.#synthAhead = clampAhead(synthAhead)
        // injectable so tests can read the flow lines (console.debug is
        // read-only in GJS)
        this.#log = log ?? ((...args) => console.debug(...args))
    }

    // Current synth-ahead window (sentences beyond the playing one), and the
    // measured real-time factor of the last sentence (for diagnostics).
    get synthAhead() { return this.#synthAhead }

    // Fold one sentence's timing into the window and emit the debug line the
    // flow is audited with: rtf < 1 means the next sentence will be ready.
    #observe(synthMs, duration, ready) {
        const audioMs = Math.max(1, (duration || 0) * 1000)
        const rtf = synthMs / audioMs
        const next = adaptWindow(this.#synthAhead, this.#rtfStreak, rtf)
        this.#synthAhead = next.window
        this.#rtfStreak = next.streak
        this.#log(`narrate: synth ${Math.round(synthMs)}ms `
            + `audio ${(duration || 0).toFixed(2)}s rtf ${rtf.toFixed(2)} `
            + `ready ${ready} win ${this.#synthAhead}`)
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
    // returns the next `{text, index, lang}`, `null` when the book ends, or
    // SECTION_END when the current section is exhausted (see `onSectionEnd`).
    // Unlike play(), the source is pulled AHEAD of playback (up to
    // `synthAhead` sentences beyond the one playing), so the sentences of
    // the next block are fetched and synthesized while the current block
    // is still being read aloud — no synthesis lands on the speaker's
    // critical path at a paragraph boundary. A section boundary is
    // discovered by lookahead but crossed only when playback reaches it:
    // `onSectionEnd()` (page the renderer) is awaited at that point, never
    // early.
    //
    // Bounds (TigerStyle): the window is clamped to [AHEAD_MIN, AHEAD_MAX];
    // `pending`/`entries` hold at most `ahead` sentences at once (each is
    // released once its audio has played); every loop iteration either
    // plays one sentence, crosses one boundary, or ends the stream.
    async playStream(source, {
        pack, voice, rate, synthAhead, onMark, onSectionPrepare,
        onSectionEnd, onEnd, onError,
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

        const ahead = clampAhead(synthAhead ?? this.#synthAhead)
        invariant(ahead >= AHEAD_MIN && ahead <= AHEAD_MAX, 'ahead in bounds')
        this.#synthAhead = ahead
        this.#rtfStreak = 0

        // Bounded state: at most `ahead` sentences are ever held. Both maps
        // are pruned as each sentence finishes playing. `ahead` is re-read
        // each iteration so the adaptive window takes effect live.
        const pending = new Map()  // index -> {text, index, lang}
        const entries = new Map()  // index -> synth promise
        let chain = Promise.resolve()
        let scheduled = -1 // highest index handed to the synth chain
        let sourceDone = false
        let failed = false
        let failure = null
        // index of the section boundary the lookahead ran into, or -1. Set
        // by fill (never past the window) and resolved only when playback
        // reaches it: lookahead may discover a boundary but never crosses it.
        let pendingSection = -1
        let preparedSection = []
        // consecutive boundary crossings that produced no sentence (empty
        // sections, e.g. image-only pages); bounded so a pathological book
        // cannot spin the loop
        let blankAdvances = 0

        const schedule = index => {
            invariant(!entries.has(index), 'index not scheduled twice')
            const s = pending.get(index)
            invariant(s !== undefined, 'sentence present before scheduling')
            invariant(typeof s.text === 'string', 'sentence text is a string')
            const entry = chain.then(async () => {
                if (run.dead || failed) return { stopped: true }
                const synthStart = Date.now()
                try {
                    const result = await this.#tts.synth(s.text, pack, {
                        lang: s.lang,
                        sid: voice ?? undefined,
                        cancellable: run.cancellable,
                    })
                    invariant(result && typeof result.wavPath === 'string',
                        'synth result has a wavPath')
                    return run.dead || failed
                        ? { stopped: true } : { result, synthMs: Date.now() - synthStart }
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
            invariant(entries.size <= this.#synthAhead, 'window not exceeded before fill')
            // Prepared sentences may be synthesized before the boundary,
            // but no further source blocks are fetched until the page turns.
            if (pendingSection !== -1 && !preparedSection.length) return
            while (!run.dead && !sourceDone && scheduled < target) {
                if (pendingSection !== -1 && !preparedSection.length) return
                const s = preparedSection.length
                    ? preparedSection.shift() : await source()
                if (run.dead) return
                if (s === SECTION_END) {
                    // hold at the boundary: the next sentence lives in the
                    // next section, which must not be paged until the audio
                    // already scheduled has played
                    if (!onSectionEnd) { sourceDone = true; return }
                    pendingSection = scheduled + 1
                    if (onSectionPrepare) {
                        preparedSection = await onSectionPrepare() ?? []
                        if (run.dead) return
                        invariant(Array.isArray(preparedSection),
                            'prepared section is an array of sentences')
                        invariant(preparedSection.length <= AHEAD_MAX,
                            'prepared section stays within the audio window')
                    }
                    if (!preparedSection.length) return
                    continue
                }
                if (!s) { sourceDone = true; return }
                invariant(typeof s.text === 'string', 'source sentence has text')
                scheduled += 1
                pending.set(scheduled, s)
                schedule(scheduled)
                blankAdvances = 0
                invariant(entries.size <= this.#synthAhead,
                    'window not exceeded after schedule')
            }
        }

        try {
            let i = 0
            while (!run.dead) {
                invariant(i >= 0, 'playback index non-negative')
                await fill(i + this.#synthAhead - 1)
                if (run.dead) break
                if (pendingSection === i) {
                    // playback has reached the boundary: now page the
                    // renderer; its first audio may already be synthesized
                    pendingSection = -1
                    blankAdvances += 1
                    if (blankAdvances > 64) { sourceDone = true; break }
                    let advanced = false
                    try {
                        advanced = await onSectionEnd()
                    } catch (e) {
                        run.dead = true
                        throw e
                    }
                    if (run.dead) break
                    if (!advanced) { sourceDone = true; break }
                    continue
                }
                // fill either produced sentence i or exhausted the source
                invariant(entries.has(i) || sourceDone,
                    'fill produced i or ended the source')
                const entry = entries.get(i)
                if (!entry) break // source exhausted, nothing left to play
                const { result, error, stopped, synthMs } = await entry
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
                invariant(pending.size <= this.#synthAhead - 1,
                    'released index frees a slot')
                // fold the measured timing into the window and log the flow
                if (synthMs != null) this.#observe(synthMs, result.duration, entries.size)
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

    // Stop the run and wait for its teardown to settle: the unwinding
    // play() reports its terminal callback only after the in-flight
    // synthesis is cancelled and its engine reaped. A pack change or a
    // chooser transition awaits this before touching model files.
    async stopAndWait() {
        const run = this.#run
        if (!run) return
        this.stop()
        try {
            await run.done
        } catch { /* the terminal callback reports failures */ }
    }
}
