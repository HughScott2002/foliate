import Gtk from 'gi://Gtk?version=4.0'
import Adw from 'gi://Adw?version=1'
import 'gi://WebKit?version=6.0'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'

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
const { Application } = await import(Gio.File.new_for_path(`${root}/src/app.js`).get_uri())
const { BookViewer } = await import(Gio.File.new_for_path(`${root}/src/book-viewer.js`).get_uri())
const delay = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
    () => (resolve(), GLib.SOURCE_REMOVE)))
const until = async (predicate, message) => {
    const deadline = Date.now() + 15000
    while (!await predicate()) {
        if (Date.now() >= deadline) throw new Error(message)
        await delay(30)
    }
}
const descendants = function* (widget) {
    yield widget
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        yield* descendants(child)
}
const check = (condition, message) => { if (!condition) throw new Error(message) }
const file = `${pkg.datadir}/zoom-test.epub`
const makeBook = `import zipfile,sys
with zipfile.ZipFile(sys.argv[1], 'w') as z:
 z.writestr('mimetype', 'application/epub+zip')
 z.writestr('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
 z.writestr('book.opf', '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">zoom-test</dc:identifier><dc:title>Zoom test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="three" href="three.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/><itemref idref="three"/></spine></package>')
 for name in ['one','two','three']:
  z.writestr(name+'.xhtml', '<html xmlns="http://www.w3.org/1999/xhtml" lang="en"><head><title>'+name+'</title></head><body><p>'+('Words for zoom testing. '*20)+'</p></body></html>')
`
Gio.Subprocess.new(['python3', '-c', makeBook, file], Gio.SubprocessFlags.NONE).wait_check(null)
const app = new Application()
app.flags |= Gio.ApplicationFlags.NON_UNIQUE
app.register(null)
app.connectOpen(app, [Gio.File.new_for_path(file)])
const win = app.active_window
const viewer = [...descendants(win)].find(w => w instanceof BookViewer)
if (!viewer) throw new Error('viewer missing')
const nav = viewer._navbar
const web = viewer._view.webView
await until(async () => (await web.eval('globalThis.reader?.view?.lastLocation?.section?.current ?? null')) === 0, 'first chapter missing')
web.zoom_level = 2
await delay(200)
await until(async () => await web.eval(
    '!!reader.view.renderer.getPreparedContents?.(1)'),
    'next chapter was not prepared before the page turn')
const zoomChanges = []
const zoomHandler = web.connect('notify::zoom-level', () =>
    zoomChanges.push(web.zoom_level))
const measure = () => web.eval(`(() => {
 const r = reader.view.renderer
 const doc = r.getContents()[0].doc
 return {
   root: r.getBoundingClientRect().width,
   iframe: doc.defaultView.frameElement.getBoundingClientRect().width,
 }
})()`)
const framePair = () => web.eval(`(() => {
 const frame = reader.view.renderer.getContents()[0]?.doc?.defaultView?.frameElement
 const current = frame?.parentElement
 const previous = current && [...current.parentElement.children]
     .find(el => el !== current && getComputedStyle(el).visibility === 'visible')
 if (!previous || getComputedStyle(current).visibility !== 'visible') return null
 return {
   distance: current.getBoundingClientRect().left - previous.getBoundingClientRect().left,
   width: current.parentElement.getBoundingClientRect().width,
   previousVisible: getComputedStyle(previous).visibility === 'visible',
 }
})()`)
const turn = viewer._view.next()
let midTurn
await until(async () => {
    midTurn = await framePair()
    return midTurn?.previousVisible
}, 'old and new chapters were not visible together during the page turn')
check(Math.abs(midTurn.distance - midTurn.width) < 2,
    `chapter frames are not adjacent during the turn: ${JSON.stringify(midTurn)}`)
await turn
await until(async () => (await web.eval('reader.view.lastLocation.section.current')) === 1, 'second chapter missing')
await delay(200)
const { root: outerWidth, iframe: chapterWidth } = await measure()
check(chapterWidth / outerWidth > 0.8 && chapterWidth / outerWidth < 1.1,
    `new chapter has incorrect layout at 200% zoom: ${chapterWidth}/${outerWidth}`)
await until(async () => await web.eval(`(() => {
 const renderer = reader.view.renderer
 return !!renderer.getPreparedContents?.(0)
     && !!renderer.getPreparedContents?.(2)
})()`), 'both neighboring chapters were not prepared')
await viewer._view.nextSection()
await until(async () => (await web.eval('reader.view.lastLocation.section.current')) === 2,
    'third chapter missing')
await until(async () => await web.eval(
    '!!reader.view.renderer.getPreparedContents?.(1)'),
    'previous chapter was not prepared after moving right')
check(!await web.eval('!!reader.view.renderer.getPreparedContents?.(0)'),
    'distant chapter remained prepared after moving right')
check(await web.eval(`(() => {
 const frame = reader.view.renderer.getContents()[0].doc.defaultView.frameElement
 return frame.parentElement.parentElement.childElementCount <= 2
})()`), 'old prepared frame was not released')
await viewer._view.prevSection()
await until(async () => (await web.eval('reader.view.lastLocation.section.current')) === 1,
    'middle chapter missing after moving left')
const back = viewer._view.prev()
await until(async () => {
    midTurn = await framePair()
    return midTurn?.previousVisible
}, 'old and new chapters were not visible together during the reverse turn')
check(Math.abs(midTurn.distance + midTurn.width) < 2,
    `chapter frames are not adjacent during the reverse turn: ${JSON.stringify(midTurn)}`)
await back
await until(async () => (await web.eval('reader.view.lastLocation.section.current')) === 0,
    'first chapter missing after reverse turn')
web.disconnect(zoomHandler)
check(zoomChanges.length === 0,
    `chapter transition changed zoom during navigation: ${zoomChanges}`)
check(Math.abs(web.zoom_level - 2) < 0.0001,
    `chapter workaround changed the selected zoom: ${web.zoom_level}`)
await until(async () => await web.eval(
    '!!reader.view.renderer.getPreparedContents?.(1)'),
    'next chapter was not prepared after the reverse turn')
await web.exec('reader.initTTS', { local: true })
nav.tts_box.state = 'playing'
check((await web.exec('reader.ttsStart'))?.ssml,
    'current chapter did not produce narration text')
let exhausted = false
for (let n = 0; n < 10; n++) {
    if (!await web.exec('reader.ttsNext')) { exhausted = true; break }
}
check(exhausted, 'current chapter narration did not reach its boundary')
const preparedAudio = await web.exec('reader.ttsPrepareNextSection')
check(preparedAudio?.ssml && preparedAudio.seq != null,
    'next chapter narration was not prepared ahead of playback')
check(await web.eval('reader.view.lastLocation.section.current') === 0,
    'narration preparation turned the visible page early')
check(await web.exec('reader.ttsNextSection'),
    'narration did not advance to the prepared chapter')
check(await web.eval(`reader.view.tts.doc ===
    reader.view.renderer.getContents()[0].doc`),
    'prepared narration document was not promoted with the visible page')
const firstMark = (await web.exec('reader.ttsParse', preparedAudio.ssml))
    .sentences[0]?.index
check(firstMark != null, 'prepared chapter had no sentence mark')
await web.exec('reader.ttsSetMark', { seq: preparedAudio.seq, mark: firstMark })
check(await web.eval(`reader.view.renderer.getContents()[0].doc.defaultView
    .CSS.highlights.has('foliate-narration')`),
    'prepared chapter audio did not highlight the visible text')
await viewer._view.prevSection()
check(await web.eval('reader.view.renderer.getContents()[0].index') === 0,
    'manual navigation did not leave the spoken chapter')
await web.exec('reader.ttsSetMark', { seq: preparedAudio.seq, mark: firstMark })
check(await web.eval('reader.view.renderer.getContents()[0].index') === 0,
    'spoken mark pulled the reader away from the browsed page')
check(nav._narration_return.visible, 'Return to narration was not offered')
await web.exec('reader.ttsReturnToNarration')
check(await web.eval('reader.view.renderer.getContents()[0].index') === 1,
    'Return to narration did not find the spoken chapter')
check(!nav._narration_return.visible, 'Return to narration stayed visible')
await viewer._view.prevSection()
for (let n = 0; n < 10; n++)
    if (!await web.exec('reader.ttsNext')) break
const nextAudio = await web.exec('reader.ttsPrepareNextSection')
check(nextAudio?.ssml, 'audio lookahead followed the browsed chapter')
check(await web.exec('reader.ttsNextSection'),
    'audio did not advance while browsing another chapter')
check(await web.eval('reader.view.renderer.getContents()[0].index') === 0,
    'audio chapter advance moved the browsed page')
await web.exec('reader.ttsSetMark', {
    seq: nextAudio.seq,
    mark: (await web.exec('reader.ttsParse', nextAudio.ssml)).sentences[0].index,
})
await web.exec('reader.ttsReturnToNarration')
check(await web.eval('reader.view.renderer.getContents()[0].index') === 2,
    'Return to narration lost the new spoken chapter')
nav.tts_box.stop()
const staleLocation = await web.eval(`(() => {
    const cfi = reader.book.sections[0].cfi
    return cfi.slice(0, -1) + '!/999:0)'
})()`)
await web.run(`reader.view.init({ lastLocation: ${JSON.stringify(staleLocation)} })`)
await until(async () => await web.eval('reader.view.lastLocation?.section?.current') === 0,
    'an invalid saved position did not recover to its chapter')
win.showLibrary()
win.openFile(Gio.File.new_for_path(file))
win.showLibrary()
win.close()
print('Zoomed chapter turns, narration, stale positions and viewer cleanup remain in sync')
