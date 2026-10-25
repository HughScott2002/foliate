import { exit } from 'system'
import { LocalTTSPlayer, adaptWindow } from '../src/local-tts-player.js'

// The flow invariant this suite protects: a sentence is synthesized BEFORE
// the sentence playing ahead of it finishes. When that holds, the reader
// never waits on synthesis at a paragraph or chapter boundary — the next
// sentence is already sitting ready. The old design synthesizes one
// *block* at a time and only fetches the next block after the current
// block's last audio ends, so the first sentence of every new block is
// synthesized on the speaker's critical path. playStream() fixes that by
// pulling blocks ahead of playback; this test fails against a design that
// does not.

let failures = 0
const assert = (cond, msg) => {
    if (cond) return
    failures++
    printerr(`FAIL: ${msg}`)
}

const tick = () => Promise.resolve()
const settle = async (n = 50) => { for (let i = 0; i < n; i++) await tick() }

// Deterministic harness: synthesis and playback both resolve only when the
// driver says so, so event ORDER is the whole test — no timers.
const makeHarness = ({ blocks }) => {
    const events = []
    const synths = new Map()
    const plays = new Map()
    const tts = {
        synth: (text) => {
            events.push(['synth-start', text])
            return new Promise((resolve, reject) => {
                synths.set(text, {
                    resolve: () => {
                        events.push(['synth-done', text])
                        resolve({ wavPath: `${text}.wav`, duration: 1 })
                    },
                    reject,
                    done: false,
                })
            })
        },
        stopAll: async () => {},
    }
    const playWav = async (wavPath) => {
        const text = wavPath.replace(/\.wav$/, '')
        events.push(['play-start', text])
        let stop
        const done = new Promise((resolve, reject) => {
            stop = () => reject(new Error('playback stopped'))
            plays.set(text, {
                resolve: () => { events.push(['play-end', text]); resolve() },
                stop, done: false,
            })
        })
        return { done, stop: () => { plays.get(text).done = true; stop() }, pause() {}, resume() {}, setRate() {} }
    }
    // Async sentence source: flattens the blocks, emitting every sentence in
    // order and recording a `fetch` event at each block boundary — so the
    // log shows exactly when a boundary was pulled relative to playback.
    let bi = 0
    let si = 0
    const source = async () => {
        await tick() // simulate one RPC round trip per sentence pull
        if (bi >= blocks.length) return null
        if (si === 0) events.push(['fetch', blocks[bi].id])
        const text = blocks[bi].sentences[si]
        si++
        if (si >= blocks[bi].sentences.length) { si = 0; bi++ }
        return { text, index: text, lang: 'en' }
    }
    return { events, tts, playWav, source, synths, plays }
}

// Model the real timing: synthesis is far faster than playback, so every
// synthesis the code has *requested* completes before any playback
// advances. That makes the test sensitive only to WHEN the code requests a
// synthesis — a design that requests a block's sentences only after the
// previous block finished playing cannot pass.
const drive = async (h, total) => {
    for (let guard = 0; guard < 500; guard++) {
        await settle()
        if (h.events.filter(e => e[0] === 'play-end').length >= total) return
        let drained = false
        for (const [, s] of h.synths)
            if (!s.done) { s.done = true; s.resolve(); drained = true }
        if (drained) { await settle(); continue }
        for (const [, p] of h.plays)
            if (!p.done) { p.done = true; p.resolve(); break }
    }
    assert(false, `driver did not finish (played ${h.events.filter(e => e[0] === 'play-end').length}/${total})`)
}

const sentencesOf = blocks => blocks.flatMap(b => b.sentences)

// Assert every sentence was synthesized before the sentence before it
// finished playing: the prefetch-before-playback invariant.
const assertPrefetched = (events, order) => {
    const pos = (type, text) => events.findIndex(e => e[0] === type && e[1] === text)
    for (let i = 1; i < order.length; i++) {
        const synthDone = pos('synth-done', order[i])
        const prevEnd = pos('play-end', order[i - 1])
        assert(synthDone !== -1 && prevEnd !== -1,
            `missing events for ${order[i]} / ${order[i - 1]}`)
        assert(synthDone < prevEnd,
            `${order[i]} was synthesized after ${order[i - 1]} finished `
            + '(synthesis on the critical path)')
    }
}

// --- case 1: block boundary inside the window ---
// 6 sentences in block one, 2 in block two, window 4: the source must pull
// block two while block one is still playing.
{
    const blocks = [
        { id: 'b1', sentences: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] },
        { id: 'b2', sentences: ['b1', 'b2'] },
    ]
    const h = makeHarness({ blocks })
    const player = new LocalTTSPlayer({ tts: h.tts, playWav: h.playWav })
    const run = player.playStream(h.source, { pack: {}, synthAhead: 4 })
    await drive(h, 8)
    await run
    assertPrefetched(h.events, sentencesOf(blocks))
    const fetchB2 = h.events.findIndex(e => e[0] === 'fetch' && e[1] === 'b2')
    const lastA = h.events.findIndex(e => e[0] === 'play-end' && e[1] === 'a6')
    assert(fetchB2 !== -1 && fetchB2 < lastA,
        'block two was fetched only after block one finished playing')
}

// --- case 2: smaller window still prefetches across the boundary ---
{
    const blocks = [
        { id: 'c1', sentences: ['c1', 'c2', 'c3'] },
        { id: 'c2', sentences: ['d1', 'd2'] },
    ]
    const h = makeHarness({ blocks })
    const player = new LocalTTSPlayer({ tts: h.tts, playWav: h.playWav })
    const run = player.playStream(h.source, { pack: {}, synthAhead: 2 })
    await drive(h, 5)
    await run
    assertPrefetched(h.events, sentencesOf(blocks))
}

// --- case 3: every sentence is synthesized in order ---
{
    const blocks = [{ id: 'e1', sentences: ['e1', 'e2', 'e3', 'e4'] }]
    const h = makeHarness({ blocks })
    const player = new LocalTTSPlayer({ tts: h.tts, playWav: h.playWav })
    const run = player.playStream(h.source, { pack: {}, synthAhead: 4 })
    await drive(h, 4)
    await run
    const synthOrder = h.events.filter(e => e[0] === 'synth-done').map(e => e[1])
    assert(JSON.stringify(synthOrder) === JSON.stringify(['e1', 'e2', 'e3', 'e4']),
        `synthesis was not in order: ${synthOrder}`)
    const playOrder = h.events.filter(e => e[0] === 'play-start').map(e => e[1])
    assert(JSON.stringify(playOrder) === JSON.stringify(['e1', 'e2', 'e3', 'e4']),
        `playback was not in order: ${playOrder}`)
}

// --- case 4: stop mid-stream ends exactly once, no callbacks after ---
{
    const blocks = [{ id: 'f1', sentences: ['f1', 'f2', 'f3', 'f4'] }]
    const h = makeHarness({ blocks })
    const player = new LocalTTSPlayer({ tts: h.tts, playWav: h.playWav })
    let ends = 0
    let errors = 0
    const run = player.playStream(h.source, {
        pack: {}, synthAhead: 4,
        onEnd: () => ends++,
        onError: () => errors++,
    })
    await settle()
    // get f1 playing, then stop
    for (const [, s] of h.synths) if (!s.done) { s.done = true; s.resolve(); break }
    await settle(20)
    player.stop()
    await run
    assert(ends === 1, `onEnd must fire exactly once on stop (got ${ends})`)
    assert(errors === 0, `stop must not report an error (got ${errors})`)
    const after = h.events.filter(e => e[0] === 'play-start').length
    await settle(20)
    assert(h.events.filter(e => e[0] === 'play-start').length === after,
        'no new playback may start after stop')
}

// --- case 5: the window is bounded — with a fast engine it adapts UP, but
// never past AHEAD_MAX ---
{
    const sentences = Array.from({ length: 50 }, (_, i) => `g${i}`)
    const blocks = [{ id: 'g1', sentences }]
    const h = makeHarness({ blocks })
    const player = new LocalTTSPlayer({ tts: h.tts, playWav: h.playWav })
    const run = player.playStream(h.source, { pack: {}, synthAhead: 4 })
    await drive(h, 50)
    await run
    let inFlight = 0
    let max = 0
    for (const [type] of h.events) {
        if (type === 'synth-start') inFlight++
        else if (type === 'play-end') inFlight--
        max = Math.max(max, inFlight)
    }
    assert(max <= 16, `synth window exceeded the cap: ${max} in flight`)
    assert(max > 4, `fast sentences should have grown the window (max ${max})`)
    assert(player.synthAhead === 16, `window should reach the cap, got ${player.synthAhead}`)
}

// --- case 6: the constructor clamps synthAhead to [1, 16] ---
{
    const h = makeHarness({ blocks: [{ id: 'h1', sentences: ['h1'] }] })
    const make = n => new LocalTTSPlayer({ tts: h.tts, playWav: h.playWav, synthAhead: n })
    assert(make(0).synthAhead === 1, 'synthAhead 0 clamps up to 1')
    assert(make(999).synthAhead === 16, 'synthAhead 999 clamps down to 16')
    assert(make(5).synthAhead === 5, 'synthAhead in range is kept')
    assert(make(undefined).synthAhead === 4, 'default window is 4')
}

// --- case 7: a non-function source is rejected ---
{
    const h = makeHarness({ blocks: [{ id: 'x', sentences: ['x1'] }] })
    const player = new LocalTTSPlayer({ tts: h.tts, playWav: h.playWav })
    let threw = false
    try { await player.playStream(null, { pack: {} }) } catch { threw = true }
    assert(threw, 'playStream must reject a non-function source')
}

// --- case 8: adaptive window arithmetic ---
{
    const AHEAD_MIN = 1
    const AHEAD_MAX = 16
    // fast sentences: grows by 2 after 3 in a row
    let s = { window: 4, streak: 0 }
    s = adaptWindow(s.window, s.streak, 0.1)
    assert(s.window === 4 && s.streak === 1, 'fast one: window holds, streak 1')
    s = adaptWindow(s.window, s.streak, 0.1)
    assert(s.window === 4 && s.streak === 2, 'fast two: window holds, streak 2')
    s = adaptWindow(s.window, s.streak, 0.1)
    assert(s.window === 6 && s.streak === 0, 'fast three: window grows by 2')
    // slow sentence: shrinks by 1 and resets the streak
    s = adaptWindow(6, 2, 0.9)
    assert(s.window === 5 && s.streak === 0, 'slow: window shrinks by 1, streak reset')
    // middle rtf: resets the streak, window unchanged
    s = adaptWindow(6, 2, 0.6)
    assert(s.window === 6 && s.streak === 0, 'middling rtf resets the streak')
    // clamps
    assert(adaptWindow(AHEAD_MIN, 0, 0.99).window === AHEAD_MIN, 'never below the minimum')
    let w = AHEAD_MAX - 1
    let st = 2
    ;({ window: w } = adaptWindow(w, st, 0.1))
    assert(w === AHEAD_MAX, 'never above the maximum')
    // non-finite rtf cannot move the window
    assert(adaptWindow(7, 0, NaN).window === 7, 'NaN rtf is inert')
}

// --- case 9: the player emits a per-sentence timing line ---
{
    const blocks = [{ id: 'k1', sentences: ['k1', 'k2', 'k3'] }]
    const h = makeHarness({ blocks })
    const lines = []
    const player = new LocalTTSPlayer({
        tts: h.tts, playWav: h.playWav, log: line => lines.push(line),
    })
    const run = player.playStream(h.source, { pack: {}, synthAhead: 4 })
    await drive(h, 3)
    await run
    const narrate = lines.filter(l => l.includes('narrate:'))
    assert(narrate.length === 3, `expected a narrate line per sentence, got ${narrate.length}`)
    assert(narrate.every(l => l.includes('rtf') && l.includes('win')),
        'narrate lines carry rtf and window')
}

if (failures) {
    printerr(`${failures} test${failures > 1 ? 's' : ''} failed`)
    exit(1)
}
print('Local TTS stream (prefetch across block boundaries) tests passed')
