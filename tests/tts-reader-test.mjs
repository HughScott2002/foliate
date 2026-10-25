// Run under Xvfb (or an existing display) with GTK4/WebKitGTK typelibs.
import Gtk from 'gi://Gtk?version=4.0'
import WebKit from 'gi://WebKit?version=6.0'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { exit } from 'system'

const source = new TextDecoder().decode(Gio.File.new_for_path(
    'src/reader/tts.js').load_contents(null)[1])
Gtk.init()
const loop = new GLib.MainLoop(null, false)
const manager = new WebKit.UserContentManager()
manager.register_script_message_handler('result', null)
let passed = false
const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
    console.error('FAIL: reader TTS test timed out')
    loop.quit()
    return GLib.SOURCE_REMOVE
})
manager.connect('script-message-received::result', (_, result) => {
    const outcome = JSON.parse(result.to_string())
    passed = outcome.passed
    print(outcome.message)
    GLib.source_remove(timeout)
    loop.quit()
})
const webView = new WebKit.WebView({ user_content_manager: manager })
const window = new Gtk.Window({ default_width: 400, default_height: 300 })
window.set_child(webView)
window.present()
webView.load_html(`<p id="book">First sentence. Second sentence.</p>
<script type="module">
${source}
const check = (ok, message) => { if (!ok) throw new Error(message) }
try {
    const input = '<speak xml:lang="en-US"><mark name="3"/>Hello &amp; '
        + '<emphasis>goodbye</emphasis>.<mark name="4"/> Second sentence.</speak>'
    const { sentences, language } = parseSSML(input)
    check(language === 'en-US', 'book language lost')
    check(JSON.stringify(sentences) === JSON.stringify([
        { text: 'Hello & goodbye.', index: '3' },
        { text: 'Second sentence.', index: '4' },
    ]), 'marks, entities or inline emphasis corrupted')
    check(parseSSML('<speak>No marks.</speak>').sentences[0].text === 'No marks.',
        'unmarked text lost')
    check(parseSSML('<speak>  <mark name="0"/> </speak>').sentences.length === 0,
        'whitespace sent to engine')
    let rejected = false
    try { parseSSML('<speak><broken></speak>') } catch { rejected = true }
    check(rejected, 'malformed XML accepted')
    const highlights = new NarrationHighlight()
    const range = document.createRange()
    range.selectNodeContents(document.querySelector('#book'))
    highlights.show(range)
    check(CSS.highlights.get('foliate-narration').has(range), 'read-along missing')
    check(document.querySelector('style[data-foliate-narration]'), 'style missing')
    highlights.clear()
    check(!CSS.highlights.has('foliate-narration'), 'highlight survives stop')
    // highlight payload routing: a bare mark or an object WITHOUT seq is the
    // speech-dispatcher path and must fall through (seq undefined)
    check(highlightTarget('3').seq === undefined && highlightTarget('3').mark === '3',
        'bare mark falls through to speechd path')
    check(highlightTarget({ mark: '3' }).seq === undefined,
        'object without seq must not be treated as local')
    check(highlightTarget({ seq: 2, mark: '3' }).seq === 2,
        'object with seq selects the snapshot path')
    window.webkit.messageHandlers.result.postMessage(JSON.stringify({
        passed: true, message: 'Reader SSML and highlight tests passed',
    }))
} catch (e) {
    window.webkit.messageHandlers.result.postMessage(JSON.stringify({
        passed: false, message: 'FAIL: ' + e.stack,
    }))
}
</script>`, 'file:///')
loop.run()
window.destroy()
exit(passed ? 0 : 1)
