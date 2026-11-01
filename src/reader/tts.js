// Keep parsing in the WebView: DOMParser handles XML entities, nested
// emphasis and namespaces without treating book markup as executable HTML.
export const parseSSML = ssml => {
    const doc = new DOMParser().parseFromString(ssml, 'application/xml')
    if (doc.querySelector('parsererror') || doc.documentElement.localName !== 'speak')
        throw new Error('Invalid narration text')
    const sentences = []
    let text = ''
    let index = '0'
    const flush = () => {
        if (text.trim()) sentences.push({ text: text.trim(), index })
        text = ''
    }
    const visit = node => {
        if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE)
            text += node.textContent
        else if (node.localName === 'mark') {
            flush()
            index = node.getAttribute('name')
        } else if (node.localName === 'break') text += ' '
        else for (const child of node.childNodes) visit(child)
    }
    visit(doc.documentElement)
    flush()
    return {
        sentences,
        language: doc.documentElement.getAttributeNS(
            'http://www.w3.org/XML/1998/namespace', 'lang') || '',
    }
}

export class NarrationHighlight {
    #window
    show(range) {
        this.clear()
        const doc = range.startContainer.ownerDocument
        const win = doc.defaultView
        if (!win.CSS?.highlights || !win.Highlight) return
        if (!doc.querySelector('style[data-foliate-narration]')) {
            const style = doc.createElement('style')
            style.dataset.foliateNarration = ''
            style.textContent = `::highlight(foliate-narration) {
                background-color: color-mix(in srgb, currentColor 18%, transparent);
            }`
            doc.head.append(style)
        }
        win.CSS.highlights.set('foliate-narration', new win.Highlight(range))
        this.#window = win
    }
    clear() {
        this.#window?.CSS.highlights.delete('foliate-narration')
        this.#window = null
    }
}

// Normalize a highlight signal payload to {mark, seq}. A `seq` (present only
// on the local path) selects the block-snapshot resolution; its absence is
// the speech-dispatcher path, resolved by foliate-js's own callback. An
// object WITHOUT seq must fall through, not be treated as local.
export const highlightTarget = x => {
    const isObj = x !== null && typeof x === 'object'
    return { mark: isObj ? x.mark : x, seq: isObj ? x.seq : undefined }
}
