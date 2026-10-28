import Gtk from 'gi://Gtk?version=4.0'
import Adw from 'gi://Adw?version=1'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'

const tmp = GLib.dir_make_tmp('foliate-controls-XXXXXX')
GLib.setenv('XDG_DATA_HOME', tmp, true)
GLib.setenv('XDG_CACHE_HOME', tmp, true)
GLib.setenv('XDG_CONFIG_HOME', tmp, true)
Gtk.init()
Adw.init()
globalThis.pkg = {
    name: 'com.github.johnfactotum.Foliate',
    moduleuri: path => Gio.File.new_for_path(`${GLib.get_current_dir()}/src/${path}`).get_uri(),
}
const { TTSBox } = await import('../src/tts.js')
const { getPacks, packDir, deletePack } = await import('../src/voice-packs.js')
await import('../src/navbar.js')
const check = (ok, message) => { if (!ok) throw new Error(message) }
const descendants = function* (widget) {
    yield widget
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        yield* descendants(child)
}
const box = new TTSBox()
let requested = false
box.connect('voices-requested', () => requested = true)
await box.start()
check(requested && box.state === 'stopped', 'missing voice must prompt without playing')
const backend = [...descendants(box)].find(w => w instanceof Gtk.DropDown)
check(backend, 'backend selector missing')
backend.selected = 1
check(box.backend === 'speechd', 'system backend selector did not switch')
backend.selected = 0
check(box.backend === 'local', 'local backend selector did not switch')
const speed = [...descendants(box)].find(w => w instanceof Gtk.SpinButton)
check(speed?.visible && speed.value === 1, 'local speed control missing')
// Read footnotes is shared content selection: it must stay visible and
// effective for both backends, not hide with the local-only controls.
const readNotes = box._read_footnotes
check(readNotes, 'shared read-footnotes control missing')
check(readNotes.visible, 'read-footnotes must be visible for the local backend')
backend.selected = 1
check(readNotes.visible, 'read-footnotes must stay visible for the system backend')
backend.selected = 0
check(readNotes.visible, 'read-footnotes must stay visible after switching back')

const pack = getPacks()[0]
GLib.mkdir_with_parents(packDir(pack.id), 0o700)
for (const name of pack.expectedFiles) {
    if (['dict', 'espeak-ng-data'].includes(name)) GLib.mkdir_with_parents(`${packDir(pack.id)}/${name}`, 0o700)
    else GLib.file_set_contents(`${packDir(pack.id)}/${name}`, 'x')
}
box.setPack(pack)
let finishInit
box.connect('init', () => new Promise(resolve => finishInit = resolve))
let started = false
box.connect('start', () => { started = true; return Promise.resolve('') })
const pending = box.start()
box.stop()
finishInit()
await pending
check(!started && box.state === 'stopped', 'stop during reader init must cancel pending narration')
deletePack(pack.id)

// --- Supertonic narrator tests with injected fakes ---
// TTSBox must accept `{ tts, player, daemonRunning }`, key warm-up primers
// by the effective narrator, pass the book SID to synthesis only for
// Supertonic, and never stop an active run when the SID changes.
const supertonic = getPacks().find(p => p.id === 'supertonic')
const installPack = pack => {
    GLib.mkdir_with_parents(packDir(pack.id), 0o700)
    for (const name of pack.expectedFiles) {
        if (['dict', 'espeak-ng-data'].includes(name))
            GLib.mkdir_with_parents(`${packDir(pack.id)}/${name}`, 0o700)
        else GLib.file_set_contents(`${packDir(pack.id)}/${name}`, 'x')
    }
}
const uninstallPack = pack => deletePack(pack.id)
const fakeTTS = () => {
    const calls = []
    return {
        calls,
        synth: async (text, pack, opts = {}) => {
            calls.push(opts)
            return { wavPath: '/nonexistent/narrator-test.wav' }
        },
        stopAll: async () => {},
    }
}
const fakePlayer = () => {
    const streams = []
    return {
        streams,
        playStream: async (_source, options) => {
            streams.push(options)
        },
        stop: () => {},
        stopAndWait: async () => {},
        pause: () => {},
        resume: () => {},
        setRate: () => {},
    }
}
const waitMicro = ms => new Promise(resolve =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
        () => (resolve(), GLib.SOURCE_REMOVE)))
installPack(supertonic)

// warm() passes sid: 9 to synth for Supertonic after setSupertonicSid(9),
// and a later warm after changing the SID synthesizes again.
{
    const tts = fakeTTS()
    const player = fakePlayer()
    const box = new TTSBox({ tts, player, daemonRunning: () => true })
    box.setPack(supertonic)
    box.setSupertonicSid(9)
    await box.warm()
    check(tts.calls.length === 1, 'supertonic warm did not synthesize')
    check(tts.calls[0].sid === 9, `warm synth got sid ${tts.calls[0].sid}, expected 9`)
    await box.warm()
    check(tts.calls.length === 1, 'warm must not re-synthesize with the same SID')
    box.setSupertonicSid(0)
    await box.warm()
    check(tts.calls.length === 2,
        'warm after a SID change must synthesize again, not stay gated by the old pack-id key')
    box.kill()
}

// a Supertonic playStream() run's synth path receives the stored SID,
// and setSupertonicSid never stops an active run
{
    const tts = fakeTTS()
    const player = fakePlayer()
    const box = new TTSBox({ tts, player, daemonRunning: () => true })
    box.setPack(supertonic)
    box.setSupertonicSid(9)
    box.connect('init', () => ({}))
    box.connect('start', () => ({ ssml: '<s>Sentence</s>', seq: 0 }))
    box.connect('parse', () => ({
        language: 'en', sentences: [{ text: 'Sentence', index: 0 }],
    }))
    box.connect('forward', () => null)
    // playStream pending so the run stays active while the SID changes
    let releaseStream
    const gate = new Promise(resolve => { releaseStream = resolve })
    player.playStream = (_source, options) => {
        player.streams.push(options)
        return gate
    }
    const run = box.start()
    await waitMicro(20)
    check(player.streams.length === 1, 'start did not hand the source to playStream')
    check(player.streams[0].voice === 9,
        `Supertonic run must pass voice 9, got ${player.streams[0].voice}`)
    // the new SID applies only to the next start: the run is untouched
    check(box.state === 'playing', 'run must be playing before the SID change')
    box.setSupertonicSid(2)
    check(box.state === 'playing',
        'setSupertonicSid must not stop an active run')
    check(player.streams[0].voice === 9,
        'setSupertonicSid must not change an already-started run')
    releaseStream()
    await run
    check(box.state === 'stopped', 'run must end cleanly')
    // the next start carries the new SID
    player.playStream = (_source, options) => {
        player.streams.push(options)
        return Promise.resolve()
    }
    player.streams = []
    await box.start()
    check(player.streams.length === 1, 'next run did not start')
    check(player.streams[0].voice === 2,
        `next run must carry the new SID, got ${player.streams[0].voice}`)
    box.kill()
}
uninstallPack(supertonic)

// Kokoro and Piper synth calls must not receive a sid property: their pack
// SID (23 / 0) still applies — warm() and playStream passes alike
{
    const kokoro = getPacks().find(p => p.id === 'kokoro')
    installPack(kokoro)
    const piper = getPacks().find(p => p.id === 'piper')
    installPack(piper)
    for (const pack of [kokoro, piper]) {
        const tts = fakeTTS()
        const player = fakePlayer()
        const box = new TTSBox({ tts, player, daemonRunning: () => true })
        box.setPack(pack)
        box.setSupertonicSid(9)
        await box.warm()
        check(tts.calls.length === 1, `${pack.id} warm did not synthesize`)
        check(!('sid' in tts.calls[0]),
            `${pack.id} warm synth must not receive a sid property`)
        // a Supertonic narrator change must not re-warm other engines
        box.setSupertonicSid(4)
        await box.warm()
        check(tts.calls.length === 1,
            `${pack.id} warm must not re-warm after a Supertonic SID change`)
        await box.start()
        check(player.streams.length === 1, `${pack.id} run did not start`)
        check(!('voice' in player.streams[0]),
            `${pack.id} playStream must not receive a voice option`)
        box.kill()
        uninstallPack(pack)
    }
}
uninstallPack(supertonic)

const builder = Gtk.Builder.new_from_string('<interface><object class="FoliateNavBar" id="nav"/></interface>', -1)
const nav = builder.get_object('nav')
// the popover needs a realized toplevel to have a surface
const navWindow = new (await import('gi://Adw?version=1')).default.Window({ width_request: 600 })
navWindow.content = nav
navWindow.present()
nav.setTTSType('tts')
const buttons = [...descendants(nav)].filter(w => w instanceof Gtk.Button)
const play = buttons.find(w => ['Pause narration', 'Resume narration'].includes(w.tooltip_text))
const stop = buttons.find(w => w.tooltip_text === 'Stop narration')
check(play && stop, 'persistent pause/stop controls missing')
nav.tts_box.state = 'playing'
check(nav.shouldStayVisible && play.get_visible() && stop.get_visible(),
    'playing must keep navbar and controls visible without popover')
play.emit('clicked')
check(nav.tts_box.state === 'paused' && nav.shouldStayVisible,
    'inline pause must hold navbar visible')
stop.emit('clicked')
check(nav.tts_box.state === 'stopped' && !nav.shouldStayVisible,
    'inline stop must release navbar')
// a modal dialog presented from a control inside the narration popover
// must not fight the popover's grab: hideNarration closes it first
nav._tts_popover.popup()
check(nav._tts_popover.visible, 'narration popover did not open')
nav.hideNarration()
check(!nav._tts_popover.visible, 'hideNarration must close the narration popover')
nav.setTTSType('media-overlay')
nav.media_overlay_box.state = 'playing'
check(nav.shouldStayVisible && play.get_visible(), 'media-overlay controls must stay visible too')
play.emit('clicked')
check(nav.media_overlay_box.state === 'paused', 'persistent pause must target media overlay')
stop.emit('clicked')
check(nav.media_overlay_box.state === 'stopped', 'persistent stop must target media overlay')
box.kill()
nav.tts_box.kill()
navWindow.destroy()
print('Narration backend and persistent controls tests passed')
