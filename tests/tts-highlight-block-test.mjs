// Runs under GTK4/WebKitGTK with a display (like tts-reader-test.mjs).
// Protects the read-along highlight from the lookahead scan: the player
// pulls blocks ahead of playback, which advances foliate-js's iterator past
// the sentence being read and overwrites its internal mark->range map. The
// reader snapshots each block's ranges at fetch time, keyed by a block
// sequence, so a sentence is always highlighted from its OWN block. This
// test reproduces the lookahead and asserts the snapshot stays correct.
import Gtk from 'gi://Gtk?version=4.0'
import WebKit from 'gi://WebKit?version=6.0'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { exit } from 'system'

const read = p => new TextDecoder().decode(Gio.File.new_for_path(p).load_contents(null)[1])
const sources = [
    read('src/foliate-js/text-walker.js'),
    read('src/foliate-js/tts.js'),
    read('src/reader/tts.js'),
]

Gtk.init()
const loop = new GLib.MainLoop(null, false)
const manager = new WebKit.UserContentManager()
manager.register_script_message_handler('result', null)
let passed = false
const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
    console.error('FAIL: highlight block test timed out')
    loop.quit()
    return GLib.SOURCE_REMOVE
})
manager.connect('script-message-received::result', (_, r) => {
    const o = JSON.parse(r.to_string())
    passed = o.passed
    print(o.message)
    GLib.source_remove(timeout)
    loop.quit()
})
const webView = new WebKit.WebView({ user_content_manager: manager })
const window = new Gtk.Window({ default_width: 400, default_height: 300 })
window.set_child(webView)
window.present()
webView.load_html(`<html lang="en"><body>
<p id="one">Alpha beta. Gamma delta.</p>
<p id="two">Epsilon zeta. Eta theta.</p>
</body>
<script type="module">
${sources.join('\n')}
const check = (ok, message) => { if (!ok) throw new Error(message) }
const blockOf = range => {
    let n = range.startContainer
    while (n && n.nodeType !== 1) n = n.parentNode
    while (n && n.tagName !== 'P') n = n.parentNode
    return n?.id
}
try {
    let captured = null
    const t = new TTS(document, textWalker, range => { captured = range }, 'sentence')
    const snapshots = []   // seq -> Map(mark -> Range), exactly like reader.js
    // same shape as reader #fetchBlock: advance one block, then snapshot
    // every mark of that block before advancing again
    const fetchBlock = () => {
        const ssml = t.next()
        if (typeof ssml !== 'string') return null   // past the end
        const marks = new Map()
        for (const s of parseSSML(ssml).sentences) {
            captured = null
            t.setMark(s.index)
            if (captured) marks.set(String(s.index), captured)
        }
        snapshots.push(marks)
        return ssml
    }
    fetchBlock()   // block one
    fetchBlock()   // block two -- the lookahead scan advances the iterator
    check(snapshots.length === 2, 'expected two blocks')
    check(blockOf(snapshots[0].get('0')) === 'one',
        'block one, mark 0 must stay in block one after lookahead advanced')
    check(snapshots[0].get('0').toString().startsWith('Alpha'),
        'block one mark 0 text wrong: ' + snapshots[0].get('0').toString())
    check(blockOf(snapshots[1].get('0')) === 'two',
        'block two, mark 0 must be in block two')
    check(snapshots[1].get('1').toString().startsWith('Eta'),
        'block two mark 1 text wrong: ' + snapshots[1].get('1').toString())
    window.webkit.messageHandlers.result.postMessage(JSON.stringify({
        passed: true, message: 'Highlight block-snapshot (lookahead safe) tests passed',
    }))
} catch (e) {
    window.webkit.messageHandlers.result.postMessage(JSON.stringify({
        passed: false, message: 'FAIL: ' + (e.message || '') + ' :: ' + e.stack,
    }))
}
</script>`, 'file:///')
loop.run()
window.destroy()
exit(passed ? 0 : 1)
