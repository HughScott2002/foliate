// Runs under GTK4/WebKitGTK with a display (like tts-reader-test.mjs).
// Protects the read-aloud DOM stripper: skippable content (footnotes,
// noteref markers, pagebreak labels, navigational asides) must never reach
// the synthesizer, while ordinary prose around it must be untouched. Roles
// are combined from tag name + ARIA role + epub:type, the Readium Guided
// Navigation classification (src/foliate-js/dom-stripper.js).
import Gtk from 'gi://Gtk?version=4.0'
import WebKit from 'gi://WebKit?version=6.0'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import { exit } from 'system'

const read = p => new TextDecoder().decode(Gio.File.new_for_path(p).load_contents(null)[1])
const stripStripperImport = src => src.replace(/^import\s+\{[^}]*\}\s+from\s+'\.\/dom-stripper\.js'\n/m, '')
const sources = [
    read('src/foliate-js/text-walker.js'),
    read('src/foliate-js/dom-stripper.js'),
    stripStripperImport(read('src/foliate-js/tts.js')),
    read('src/reader/tts.js'),
]

Gtk.init()
const loop = new GLib.MainLoop(null, false)
const manager = new WebKit.UserContentManager()
manager.register_script_message_handler('result', null)
let passed = false
const timeout = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 30, () => {
    console.error('FAIL: TTS roles test timed out')
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
webView.load_html(`<html lang="en" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<main>
<p>Alpha beta<span epub:type="noteref">1</span> gamma delta.</p>
<p>Second paragraph stays here.</p>
<aside epub:type="footnote"><p>Sneaky footnote words.</p></aside>
<p>Paged text <span epub:type="pagebreak">42</span> after the break.</p>
<p role="doc-noteref">99</p>
<p>List items follow.</p>
<nav epub:type="toc"><ol><li>Contents entry</li></ol></nav>
<p>O'Reilly style<span data-type="noteref">7</span> marker.</p>
<div data-type="footnotes"><p data-type="footnote">Atlas footnote body.</p></div>
<p>Paged <span data-type="pagebreak">88</span> again.</p>
</main>
</body>
<script type="module">
${sources.join('\n')}
const check = (ok, message) => { if (!ok) throw new Error(message) }
try {
    // classify a few nodes directly: the three signals, in order
    const aside = document.querySelector('aside')
    check(JSON.stringify(extractNodeRoles(aside)) === JSON.stringify(['aside', 'footnote']),
        'aside roles wrong: ' + JSON.stringify(extractNodeRoles(aside)))
    const noteref = document.querySelector('p span')
    check(isSkippable(noteref), 'noteref not skippable')
    check(extractNodeRoles(document.querySelector('[role="doc-noteref"]')).includes('noteref'),
        'aria doc-noteref not mapped')
    check(isSkippable(document.querySelector('nav')), 'toc nav not skippable')
    check(!isSkippable(document.querySelector('p')), 'plain paragraph wrongly skippable')
    // O'Reilly/Atlas data-type convention (no epub:type/ARIA at all)
    const oreilly = document.querySelector('[data-type="noteref"]')
    check(extractNodeRoles(oreilly).includes('noteref'),
        'data-type noteref not mapped')
    check(isSkippable(oreilly), 'data-type noteref not skippable')
    check(isSkippable(document.querySelector('[data-type="footnotes"]')),
        'data-type footnotes container not skippable')
    // a presentation role strips native semantics
    const probe = document.createElement('aside')
    probe.setAttribute('role', 'presentation')
    check(!isSkippable(probe), 'presentation role did not strip aside semantics')

    // end to end: walk the book as narration does and collect the speech
    const t = new TTS(document, textWalker, () => {}, 'sentence')
    const spoken = []
    for (let i = 0; i < 30; i++) {
        const ssml = t.next()
        if (typeof ssml !== 'string') break
        for (const s of parseSSML(ssml).sentences) spoken.push(s.text)
    }
    const text = spoken.join(' ')
    check(text.includes('Alpha beta') && text.includes('gamma delta'),
        'prose around a noteref was lost: ' + JSON.stringify(text))
    check(text.includes('Second paragraph stays here'),
        'ordinary paragraph dropped: ' + JSON.stringify(text))
    check(text.includes('Paged text') && text.includes('after the break'),
        'prose around a pagebreak was lost: ' + JSON.stringify(text))
    check(!text.includes('Sneaky footnote words'), 'footnote was spoken: ' + JSON.stringify(text))
    check(!text.includes('1') && !text.includes('99'),
        'noteref marker was spoken: ' + JSON.stringify(text))
    check(!text.includes('42'), 'pagebreak label was spoken: ' + JSON.stringify(text))
    check(!text.includes('Contents entry'), 'toc entry was spoken: ' + JSON.stringify(text))
    // a <script> in the body must never be serialized into SSML (the walk
    // rejects it, but the SSML is built from the fragment markup)
    check(!text.includes('getFragmentWithMarks'),
        'inline script text was spoken: ' + JSON.stringify(text))
    check(text.includes("O'Reilly style") && text.includes('marker'),
        'prose around a data-type noteref was lost: ' + JSON.stringify(text))
    check(text.includes('Paged') && text.includes('again'),
        'prose around a data-type pagebreak was lost: ' + JSON.stringify(text))
    check(!text.includes('Atlas footnote body'), 'data-type footnote was spoken: ' + JSON.stringify(text))
    check(!text.includes('7'), 'data-type noteref marker was spoken: ' + JSON.stringify(text))
    check(!text.includes('88'), 'data-type pagebreak label was spoken: ' + JSON.stringify(text))
    window.webkit.messageHandlers.result.postMessage(JSON.stringify({
        passed: true, message: 'Narration DOM stripper (skippable roles) tests passed',
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
