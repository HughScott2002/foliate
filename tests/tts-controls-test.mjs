import Gtk from 'gi://Gtk?version=4.0'
import Adw from 'gi://Adw?version=1'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'

const tmp = GLib.dir_make_tmp('foliate-controls-XXXXXX')
GLib.setenv('XDG_DATA_HOME', tmp, true)
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

const pack = getPacks()[0]
GLib.mkdir_with_parents(packDir(pack.id), 0o700)
for (const name of pack.expectedFiles) {
    if (['dict', 'espeak-ng-data'].includes(name)) GLib.mkdir_with_parents(`${packDir(pack.id)}/${name}`, 0o700)
    else GLib.file_set_contents(`${packDir(pack.id)}/${name}`, '')
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

const builder = Gtk.Builder.new_from_string('<interface><object class="FoliateNavBar" id="nav"/></interface>', -1)
const nav = builder.get_object('nav')
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
nav.setTTSType('media-overlay')
nav.media_overlay_box.state = 'playing'
check(nav.shouldStayVisible && play.get_visible(), 'media-overlay controls must stay visible too')
play.emit('clicked')
check(nav.media_overlay_box.state === 'paused', 'persistent pause must target media overlay')
stop.emit('clicked')
check(nav.media_overlay_box.state === 'stopped', 'persistent stop must target media overlay')
box.kill()
nav.tts_box.kill()
print('Narration backend and persistent controls tests passed')
