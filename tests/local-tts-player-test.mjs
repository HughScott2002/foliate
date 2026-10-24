import { exit } from 'system'
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'

// Isolation first: nothing in this suite touches the real cache, home,
// or audio devices — the TTS engine and the pipeline are both faked.
const tmp = GLib.dir_make_tmp(null)

import { LocalTTSPlayer } from '../src/local-tts-player.js'

let failures = 0
const assert = (cond, msg) => {
    if (cond) return
    failures++
    printerr(`FAIL: ${msg}`)
}

// a hung queue must fail the run instead of spinning forever
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20000, () =>
    (printerr('FAIL: test run timed out'), exit(1)))

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
// a plain delay, for negative assertions (nothing more may happen)
const tick = ms => new Promise(resolve =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
        () => (resolve(), GLib.SOURCE_REMOVE)))

// await a play() run, reporting an unexpected rejection as a failure
// instead of aborting the module mid-assertions
const settle = async promise => {
    try {
        await promise
    } catch (error) {
        failures++
        printerr('FAIL: unexpected play() rejection: ' +
            `${error?.message ?? error}`)
    }
}

// --- fixture: a real tiny wav (0.5 s of silence, 8 kHz mono 16-bit) ---

const wavPath = GLib.build_filenamev([tmp, 'fixture.wav'])
{
    const n = 4000
    const buf = new ArrayBuffer(44 + n * 2)
    const view = new DataView(buf)
    const put = (offset, str) => {
        for (let i = 0; i < str.length; i++)
            view.setUint8(offset + i, str.charCodeAt(i))
    }
    put(0, 'RIFF')
    view.setUint32(4, 36 + n * 2, true)
    put(8, 'WAVE')
    put(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 8000, true)
    view.setUint32(28, 16000, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    put(36, 'data')
    view.setUint32(40, n * 2, true)
    const file = Gio.File.new_for_path(wavPath)
        .replace(null, false, Gio.FileCreateFlags.NONE, null)
    file.write_bytes(new GLib.Bytes(new Uint8Array(buf)), null)
    file.close(null)
}

// --- fakes: the synth side mirrors the LocalTTS contract, the play
// side mirrors the playWav promise contract ---

// fake LocalTTS: returns a real wav fixture; with hold, synth promises
// stay pending until release() — and stopAll() rejects them, exactly
// what the real engine does when its subprocess is killed.
class FakeTTS {
    constructor({ hold = false, failTexts = [] } = {}) {
        this.hold = hold
        this.failTexts = failTexts
        this.calls = [] // { text, lang, sid }
        this.inFlight = 0
        this.maxInFlight = 0
        this.held = []
        this.stopAllCount = 0
    }
    async synth(text, pack, { lang, sid, cancellable } = {}) {
        this.calls.push({ text, lang, sid, cancellable })
        this.inFlight++
        this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
        try {
            if (this.failTexts.includes(text))
                throw new Error('engine exploded')
            await new Promise((resolve, reject) => {
                if (!this.hold) return resolve()
                this.held.push({ resolve, reject })
            })
            return { wavPath, duration: 0.5 }
        } finally {
            this.inFlight--
        }
    }
    release(n = 1) {
        while (n-- > 0 && this.held.length) this.held.shift().resolve()
    }
    async stopAll() {
        this.stopAllCount++
        this.held.splice(0).forEach(({ reject }) =>
            reject(new Error('synthesis stopped')))
    }
}

// fake playWav: one session per call, blocked until release(); stop()
// rejects with the contracted stop error. Records the rate and every
// pause/resume/stop/setRate hook the player delivers.
const makeFakePlayWav = () => {
    const sessions = []
    const playWav = (path, { rate } = {}) => {
        const session = { path, rate, hooks: [] }
        const promise = new Promise((resolve, reject) => {
            session.release = () => resolve()
            session.stopPipeline = () =>
                reject(new Error('playback stopped'))
        })
        promise.pause = () => session.hooks.push('pause')
        promise.resume = () => session.hooks.push('resume')
        promise.stop = () => {
            session.hooks.push('stop')
            session.stopPipeline()
        }
        promise.setRate = rate => session.hooks.push(['setRate', rate])
        sessions.push(session)
        return promise
    }
    return { playWav, sessions }
}

const TEXTS = ['One.', 'Two.', 'Three.', 'Four.']
const sentencesOf = n => TEXTS.slice(0, n)
    .map((text, index) => ({ text, index }))
const PACK = { id: 'kokoro', sid: 23 }

// harness for one scenario: fresh fakes, a player over them, and the
// callback collectors the assertions read afterwards
const start = ({ hold = false, failTexts } = {}) => {
    const tts = new FakeTTS({ hold, failTexts })
    const fake = makeFakePlayWav()
    const marks = []
    const ends = []
    const errors = []
    const player = new LocalTTSPlayer({ tts, playWav: fake.playWav })
    const run = (n, options = {}) => {
        const done = player.play(sentencesOf(n), {
            pack: PACK,
            onMark: index => marks.push(index),
            onEnd: value => ends.push(value),
            onError: error => errors.push(error),
            ...options,
        })
        done.catch(error => {
            failures++
            printerr('FAIL: unexpected play() rejection: ' +
                `${error?.message ?? error}`)
        })
        return done
    }
    return { tts, sessions: fake.sessions, marks, ends, errors, player, run }
}

// --- the queue plays sentences in order, marking at play-start ---

{
    const { tts, sessions, marks, ends, errors, run } = start()
    const done = run(3)
    assert(await waitFor(() => sessions.length === 1),
        'the first sentence started playing')
    assert(JSON.stringify(marks) === '[0]',
        `onMark(0) fired at play-start (got: ${JSON.stringify(marks)})`)
    sessions[0].release()
    assert(await waitFor(() => sessions.length === 2),
        'the second sentence played after the first ended')
    assert(JSON.stringify(marks) === '[0,1]',
        `onMark fired in order (got: ${JSON.stringify(marks)})`)
    sessions[1].release()
    assert(await waitFor(() => sessions.length === 3),
        'the third sentence played after the second ended')
    assert(JSON.stringify(marks) === '[0,1,2]',
        `onMark covers every sentence in order (got: ${JSON.stringify(marks)})`)
    sessions[2].release()
    await settle(done)
    assert(ends.length === 1 && ends[0] === null,
        `onEnd(null) fired exactly once (got: ${JSON.stringify(ends)})`)
    assert(errors.length === 0, 'nothing failed on the happy path')
    assert(JSON.stringify(tts.calls.map(c => c.text))
            === JSON.stringify(TEXTS.slice(0, 3)),
    'synthesis ran in playback order')
    assert(tts.calls.every(c => c.lang === undefined && c.sid === undefined),
        'no lang/voice overrides without options')
    assert(sessions.every(s => s.path === wavPath),
        'the wav the synth returned is the wav that was played')
    assert(sessions.every(s => s.rate === 1),
        'the default rate reaches the pipeline (got: ' +
        `${sessions.map(s => s.rate)})`)
}

// --- the rate option reaches the pipeline, clamped to 0.75–2.0 ---

{
    {
        const { sessions, run } = start()
        const done = run(1, { rate: 1.5 })
        assert(await waitFor(() => sessions.length === 1),
            'playback started at rate 1.5')
        assert(sessions[0].rate === 1.5,
            `the rate option reaches the pipeline (got: ${sessions[0].rate})`)
        sessions[0].release()
        await settle(done)
    }
    {
        const { sessions, run } = start()
        const done = run(1, { rate: 9 })
        assert(await waitFor(() => sessions.length === 1),
            'playback started with an out-of-range high rate')
        assert(sessions[0].rate === 2,
            `a rate above 2.0 clamps to 2.0 (got: ${sessions[0].rate})`)
        sessions[0].release()
        await settle(done)
    }
    {
        const { sessions, run } = start()
        const done = run(1, { rate: 0 })
        assert(await waitFor(() => sessions.length === 1),
            'playback started with an out-of-range low rate')
        assert(sessions[0].rate === 0.75,
            `a rate below 0.75 clamps to 0.75 (got: ${sessions[0].rate})`)
        sessions[0].release()
        await settle(done)
    }
}

// --- the synth-ahead window: at most two sentences ahead of playback ---

{
    const { tts, sessions, marks, ends, run } = start({ hold: true })
    const done = run(4)
    assert(await waitFor(() => tts.calls.length === 1),
        'the first sentence synthesized first')
    assert(marks.length === 0,
        'onMark waits for play-start, not for synthesis')
    tts.release() // synth 0 done -> playback of sentence 0 starts
    assert(await waitFor(() => sessions.length === 1),
        'playback started once the first wav existed')
    await waitFor(() => tts.calls.length === 2)
    assert(marks.length === 1 && marks[0] === 0,
        'onMark fired when playback started, not at synth completion')
    tts.release() // synth 1 done -> sentence 2 synthesizes (ahead)
    assert(await waitFor(() => tts.calls.length === 3),
        'synth-ahead runs two sentences past playback')
    await tick(50)
    assert(tts.calls.length === 3,
        'no synth runs more than two sentences ahead of playback ' +
        `(got: ${tts.calls.length})`)
    assert(tts.maxInFlight <= 2,
        `at most two synths are ever in flight (got: ${tts.maxInFlight})`)
    tts.release() // synth 2 done
    sessions[0].release() // playback advances to sentence 1
    assert(await waitFor(() => tts.calls.length === 4),
        'the next synth-ahead kicks in as playback advances')
    await tick(50)
    assert(tts.calls.length === 4,
        `the window never widens (got: ${tts.calls.length})`)
    assert(tts.maxInFlight <= 2,
        `at most two synths are ever in flight (got: ${tts.maxInFlight})`)
    tts.release(2) // anything still held resolves
    for (let i = 1; i < 4; i++) {
        assert(await waitFor(() => sessions.length > i, 1000),
            `playback advanced to sentence ${i}`)
        sessions[i].release()
    }
    await settle(done)
    assert(ends.length === 1 && ends[0] === null,
        `the window run ended cleanly (got: ${JSON.stringify(ends)})`)
}

// --- stop(): pipeline stopped, synth cancelled, onEnd fired once ---

{
    const { tts, sessions, marks, ends, errors, run, player } = start({
        hold: true,
    })
    const done = run(4)
    await waitFor(() => tts.calls.length === 1)
    tts.release()
    assert(await waitFor(() => sessions.length === 1),
        'playback started before the stop')
    await waitFor(() => tts.calls.length === 2)
    try {
        await player.play(sentencesOf(1), { pack: PACK })
        failures++
        printerr('FAIL: a second play() while active should be rejected')
    } catch (error) {
        assert(/already in progress/i.test(error.message),
            `a second play() rejects cleanly (got: ${error.message})`)
    }
    player.stop()
    await settle(done)
    assert(ends.length === 1 && ends[0] === null,
        `stop fired onEnd(null) exactly once (got: ${JSON.stringify(ends)})`)
    assert(errors.length === 0, 'a stop is not an error')
    assert(JSON.stringify(marks) === '[0]',
        `no marks after the stop (got: ${JSON.stringify(marks)})`)
    assert(sessions.length === 1, 'no further playback after the stop')
    assert(sessions[0].hooks.includes('stop'),
        'stop() stopped the active pipeline (hooks: ' +
        `${JSON.stringify(sessions[0].hooks)})`)
    await tick(30)
    assert(tts.inFlight === 0, 'no pending synth survives the stop')
    assert(tts.calls.length === 2,
        'queued synth ahead of playback was abandoned (got: ' +
        `${tts.calls.length})`)
    assert(tts.stopAllCount >= 1, 'stop() cancelled synthesis via stopAll()')
}

// --- pause() and resume() reach the active pipeline ---

{
    const { tts, sessions, ends, run, player } = start({ hold: true })
    const done = run(1)
    await waitFor(() => tts.calls.length === 1)
    tts.release()
    assert(await waitFor(() => sessions.length === 1),
        'playback started for the pause/resume run')
    player.pause()
    player.resume()
    assert(JSON.stringify(sessions[0].hooks) === '["pause","resume"]',
        'pause/resume reach the pipeline in order (hooks: ' +
        `${JSON.stringify(sessions[0].hooks)})`)
    sessions[0].release()
    await settle(done)
    assert(ends.length === 1 && ends[0] === null,
        'playback finished after resume')
}

// --- a session created while paused starts paused ---

{
    const { sessions, run, player } = start({ hold: false })
    player.pause() // paused before anything plays
    const done = run(1)
    assert(await waitFor(() => sessions.length === 1),
        'playback started while paused')
    assert(JSON.stringify(sessions[0].hooks) === '["pause"]',
        'a session created while paused starts paused (hooks: ' +
        `${JSON.stringify(sessions[0].hooks)})`)
    player.resume()
    assert(JSON.stringify(sessions[0].hooks) === '["pause","resume"]',
        'resume() reaches the paused session (hooks: ' +
        `${JSON.stringify(sessions[0].hooks)})`)
    sessions[0].release()
    await settle(done)
}

// --- a synth rejection surfaces onError and halts the queue ---

{
    const { tts, sessions, marks, ends, errors, run } = start({
        failTexts: ['Two.'],
    })
    const done = run(3)
    assert(await waitFor(() => sessions.length === 1),
        'playback started before the failure')
    sessions[0].release()
    await settle(done)
    assert(errors.length === 1 && /engine exploded/.test(errors[0].message),
        'a synth rejection surfaces onError (got: ' +
        `${errors.map(String)})`)
    assert(JSON.stringify(marks) === '[0]',
        `no marks after the failure (got: ${JSON.stringify(marks)})`)
    assert(sessions.length === 1, 'playback of later sentences stopped')
    assert(ends.length === 0, 'a failed run does not fire onEnd')
    assert(JSON.stringify(tts.calls.map(c => c.text))
            === JSON.stringify(['One.', 'Two.']),
    'the queue stops asking for synth after a failure (got: ' +
        `${JSON.stringify(tts.calls.map(c => c.text))})`)
}

// --- setRate retunes the active and following sentences ---

{
    const { sessions, run, player } = start()
    const done = run(2)
    assert(await waitFor(() => sessions.length === 1),
        'the first session is active before retuning')
    player.setRate(1.5)
    assert(JSON.stringify(sessions[0].hooks) === '[["setRate",1.5]]',
        'setRate reaches the active pipeline (hooks: ' +
        `${JSON.stringify(sessions[0].hooks)})`)
    sessions[0].release()
    assert(await waitFor(() => sessions.length === 2),
        'the second session started')
    assert(sessions[1].rate === 1.5,
        'the retuned rate applies to later sentences (got: ' +
        `${sessions[1].rate})`)
    player.setRate(5)
    player.setRate(0.1)
    assert(JSON.stringify(sessions[1].hooks)
            === '[["setRate",2],["setRate",0.75]]',
    'out-of-range retunes clamp to the UI range (hooks: ' +
        `${JSON.stringify(sessions[1].hooks)})`)
    sessions[1].release()
    await settle(done)
}

// --- the voice option is the synth sid override ---

{
    const { tts, sessions, run } = start()
    const done = run(1, { voice: 7 })
    assert(await waitFor(() => sessions.length === 1),
        'the voice run played its sentence')
    sessions[0].release()
    await settle(done)
    assert(tts.calls.every(c => c.sid === 7),
        'the voice option reaches synth as the sid (got: ' +
        `${JSON.stringify(tts.calls.map(c => c.sid))})`)
}

if (failures) {
    printerr(`${failures} test${failures > 1 ? 's' : ''} failed`)
    exit(1)
}
print('All tests passed')
