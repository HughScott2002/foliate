// Opt-in: real models, sherpa-onnx and GStreamer. Uses caller's isolated XDG dirs.
import Gtk from 'gi://Gtk?version=4.0'
import Adw from 'gi://Adw?version=1'
import 'gi://WebKit?version=6.0'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import Graphene from 'gi://Graphene'
import { exit } from 'system'

if (GLib.getenv('FOLIATE_REAL_TTS_TEST') !== '1') {
    print('SKIPPED: real narration integration (set FOLIATE_REAL_TTS_TEST=1 with isolated XDG dirs)')
    exit(0)
}
Gtk.init()
Adw.init()
const root = GLib.get_current_dir()
globalThis.pkg = {
    name: 'com.github.johnfactotum.Foliate', version: '3.3.0',
    localeName: 'Foliate', MESON: false,
}
GLib.set_prgname(pkg.name)
GLib.set_application_name(pkg.localeName)
for (const [key, dir] of Object.entries({
    data: GLib.get_user_data_dir(), cache: GLib.get_user_cache_dir(), config: GLib.get_user_config_dir(),
})) {
    pkg[`${key}dir`] = `${dir}/${pkg.name}`
    pkg[`${key}path`] = path => `${pkg[`${key}dir`]}/${path}`
    GLib.mkdir_with_parents(pkg[`${key}dir`], 0o700)
}
pkg.datafile = path => Gio.File.new_for_path(pkg.datapath(path))
pkg.modulepath = path => `${root}/src/${path}`
pkg.moduleuri = path => Gio.File.new_for_path(pkg.modulepath(path)).get_uri()
const { Application } = await import('../src/app.js')
const { BookViewer } = await import('../src/book-viewer.js')
const check = (ok, message) => { if (!ok) throw new Error(message) }
const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
    () => (resolve(), GLib.SOURCE_REMOVE)))
const until = async (predicate, message) => {
    const deadline = Date.now() + 30000
    while (!await predicate()) {
        check(Date.now() < deadline, message)
        await delay(25)
    }
}
const descendants = function* (widget) {
    yield widget
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        yield* descendants(child)
}
const file = `${pkg.datadir}/narration-test.epub`
const makeBook = `import zipfile,sys,uuid
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 z.writestr('mimetype', 'application/epub+zip')
 z.writestr('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
 z.writestr('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">TEST-ID</dc:identifier><dc:title>Local narration test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>'.replace('TEST-ID', str(uuid.uuid4())))
 for name,text in [('one','This is the first sentence. This is another sentence in the first chapter.'), ('two','This is the second chapter. Local narration has crossed a chapter boundary.')]:
  z.writestr(name+'.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>Narration</title></head><body><p>'+text+'</p></body></html>')
`
Gio.Subprocess.new(['python3', '-c', makeBook, file], Gio.SubprocessFlags.NONE).wait_check(null)
const app = new Application()
app.flags |= Gio.ApplicationFlags.NON_UNIQUE
app.register(null)
app.connectOpen(app, [Gio.File.new_for_path(file)])
const win = app.active_window
const viewer = [...descendants(win)].find(w => w instanceof BookViewer)
check(viewer, 'book viewer missing')
const nav = viewer._navbar
const tts = nav.tts_box
const web = viewer._view.webView
await until(() => tts.pack, 'book never became ready')
check(tts.pack.id === 'supertonic',
    `English book did not select the default pack (got ${tts.pack.id})`)
let marks = 0
tts.connect('highlight', () => { marks++ })
tts.start()
await until(async () => marks > 0 && await web.eval(
    'reader.view.renderer.getContents()[0].doc.defaultView.CSS.highlights.has("foliate-narration")'),
'sentence was not highlighted during playback')
check(nav.shouldStayVisible && viewer._navbar_revealer.reveal_child,
    'playback navbar disappeared')
tts.pause()
check(tts.state === 'paused' && nav.shouldStayVisible, 'pause hid controls')
// Capture rendered app, including WebKit highlight and persistent controls.
await delay(250)
const paintable = new Gtk.WidgetPaintable({ widget: win })
const snapshot = new Gtk.Snapshot()
paintable.snapshot(snapshot, win.get_width(), win.get_height())
const bounds = new Graphene.Rect()
bounds.init(0, 0, win.get_width(), win.get_height())
const node = snapshot.to_node()
win.get_renderer().render_texture(node, bounds).save_to_png('/tmp/opencode/foliate-narration.png')
tts.start()
await until(() => tts.state === 'stopped', 'narration never reached book end')
check(marks >= 4, 'narration did not cross all sentence/chapter marks')
check(!await web.eval('reader.view.renderer.getContents()[0].doc.defaultView.CSS.highlights.has("foliate-narration")'),
    'highlight survived end of book')
check(!nav.shouldStayVisible, `navbar remained pinned after narration ended: tts=${tts.state}, `
    + `location=${nav._location_popover.visible}, narration=${nav._tts_popover.visible}`)
win.close()
print('Real narration, pause/resume, chapter transition and highlight integration passed')
