import Adw from 'gi://Adw'
import Gtk from 'gi://Gtk'
import Gio from 'gi://Gio'
import GObject from 'gi://GObject'
import Pango from 'gi://Pango'
import { gettext as _ } from 'gettext'
import * as voicePacks from './voice-packs.js'
import { getPacks, verifyPack, deletePack, packDir } from './voice-packs.js'
import { getVoicePackJobs } from './voice-pack-jobs.js'
import { LocalTTS } from './local-tts.js'
import { LocalTTSPlayer } from './local-tts-player.js'

const LANGUAGE_NAMES = {
    en: 'English', zh: 'Chinese', ko: 'Korean', ja: 'Japanese', ar: 'Arabic',
    bg: 'Bulgarian', cs: 'Czech', da: 'Danish', de: 'German', el: 'Greek',
    es: 'Spanish', et: 'Estonian', fi: 'Finnish', fr: 'French', hi: 'Hindi',
    hr: 'Croatian', hu: 'Hungarian', id: 'Indonesian', it: 'Italian',
    lt: 'Lithuanian', lv: 'Latvian', nl: 'Dutch', pl: 'Polish',
    pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sk: 'Slovak',
    sl: 'Slovenian', sv: 'Swedish', tr: 'Turkish', uk: 'Ukrainian',
    vi: 'Vietnamese',
}

const languageSummary = pack => {
    if (!pack.languages?.length) return _('Unknown languages')
    const names = pack.languages.map(code => LANGUAGE_NAMES[code] ?? code)
    if (names.length > 3)
        return _('%s + %d more')
            .replace('%s', names[0])
            .replace('%d', String(names.length - 1))
    return names.join(', ')
}

const friendlyError = error => {
    const message = error?.message ?? String(error)
    if (/cancel/i.test(message)) return _('Cancelled.')
    if (/HTTP|network|connection|socket|refused|timed out/i.test(message))
        return _('Download failed. Check your connection and try again.')
    if (/checksum|size mismatch|missing expected|damaged|corrupt/i.test(message))
        return _('The downloaded voice is damaged. Download it again.')
    if (/already exists/i.test(message))
        return _('This voice is already installed.')
    return _('The voice operation failed. Try again.')
}

const technicalDetails = error => {
    const message = error?.message ?? String(error)
    return error?.stack ? `${message}\n\n${error.stack}` : message
}

const transientStates = new Set([
    'downloading', 'verifying', 'previewing', 'failed',
])

export const VoiceManagerDialog = GObject.registerClass({
    Signals: {
        'voice-selected': { param_types: [GObject.TYPE_JSOBJECT] },
        'voice-removed': { param_types: [GObject.TYPE_STRING] },
        'narrator-selected': { param_types: [GObject.TYPE_UINT] },
        'narrator-reset': {},
    },
}, class extends Adw.Dialog {
    #items = new Map()
    #order = []
    #selectedId = null
    #recommendedId = null
    #cancellable = null
    #operation = null
    #operationPromise = null
    #previewing = false
    #previewStopped = false
    #lease = null
    #closed = false
    #player = null
    #operations = {}
    #ui = {}
    #jobs
    #unsubscribe = null
    #seenJobs = new Map()
    #narrator = null
    #storedSid = null
    #pendingSid = null
    #appliedSid = 0
    #updatingNarrator = false
    #getGlobalSid = null

    constructor({
        packs = getPacks(),
        language = 'en',
        selected = null,
        operations = {},
        player = null,
        jobs = getVoicePackJobs(),
        effectiveSid = 0,
        storedSid = null,
        getGlobalSid = () => 0,
    } = {}) {
        super({ title: _('Choose Voice'), content_width: 520, content_height: 520 })
        this.#player = player ?? new LocalTTSPlayer({ tts: new LocalTTS() })
        this.#jobs = jobs
        this.#operations = {
            getPackState: operations.getPackState ?? (pack => {
                if (typeof voicePacks.getPackState === 'function')
                    return voicePacks.getPackState(pack)
                return {
                    status: verifyPack(pack) ? 'installed' : 'missing',
                    message: null,
                }
            }),
            repairPack: operations.repairPack
                ?? (typeof voicePacks.repairPack === 'function'
                    ? voicePacks.repairPack : null),
            ensurePackReady: operations.ensurePackReady ?? null,
            prepareVoicePackChange: operations.prepareVoicePackChange ?? null,
            stopAndWait: operations.stopAndWait ?? (() => {
                if (typeof this.#player.stopAndWait === 'function')
                    return this.#player.stopAndWait()
                this.#player.stop()
                return Promise.resolve()
            }),
        }
        this.#recommendedId = this.#pickRecommended(packs, language)
        this.#selectedId = selected && packs.some(p => p.id === selected)
            ? selected : this.#recommendedId
        if (packs.some(pack => pack.id === jobs.active?.packId))
            this.#selectedId = jobs.active.packId

        const toolbar = new Adw.ToolbarView()
        toolbar.add_top_bar(new Adw.HeaderBar())
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 12,
            margin_top: 18, margin_bottom: 18, margin_start: 18, margin_end: 18,
        })
        content.append(new Gtk.Label({
            label: _('Download once, then listen offline. Book text stays on your computer.'),
            wrap: true, xalign: 0,
        }))

        const group = new Adw.PreferencesGroup({ title: _('Local Voices') })
        content.append(group)

        for (const pack of packs) {
            const row = new Adw.ActionRow({
                title: pack.label, activatable: true,
            })
            const recommended = new Gtk.Label({
                label: _('Recommended'), css_classes: ['dim-label'],
                valign: Gtk.Align.CENTER, visible: false,
            })
            const candidate = new Gtk.Label({
                label: _('New'), css_classes: ['accent'],
                valign: Gtk.Align.CENTER, visible: false,
            })
            const check = new Gtk.Image({
                icon_name: 'object-select-symbolic',
                valign: Gtk.Align.CENTER, visible: false,
            })
            const suffix = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL, spacing: 8,
                valign: Gtk.Align.CENTER,
            })
            suffix.append(recommended)
            suffix.append(candidate)
            suffix.append(check)
            row.add_suffix(suffix)
            group.add(row)
            const item = {
                pack, row, recommended, candidate, check,
                state: 'missing', ready: false, candidateFlag: false,
                error: null, details: null, progress: null, lastOperation: null,
                backendInvalid: null,
            }
            this.#items.set(pack.id, item)
            this.#order.push(item)
            row.connect('activated', () => this.#select(pack.id))
        }

        // Book-level narrator group. Only Supertonic takes a narrator
        // choice; other engines keep their own fixed voices. The combo
        // value, the stored book SID, and a pending user change are
        // separate pieces of state.
        const narratorGroup = new Adw.PreferencesGroup()
        const narratorCombo = new Adw.ComboRow({
            title: _('Narrator'), model: new Gtk.StringList(),
        })
        for (const { sid } of voicePacks.NARRATORS)
            narratorCombo.model.append(voicePacks.narratorLabel(sid))
        narratorGroup.add(narratorCombo)
        narratorGroup.visible = false
        content.append(narratorGroup)
        this.#narrator = { group: narratorGroup, combo: narratorCombo }
        this.#storedSid = storedSid ?? null
        this.#getGlobalSid = getGlobalSid
        this.#setNarratorCombo(effectiveSid)
        // the SID already in effect (from the viewer): combo changes back
        // to it are net-zero and must not become a book-specific choice
        this.#appliedSid = effectiveSid
        narratorCombo.connect('notify::selected', combo => {
            if (!this.#updatingNarrator)
                this.#pendingSid = combo.selected === this.#appliedSid
                    ? null : combo.selected
        })

        const actions = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL, spacing: 12, margin_top: 6,
        })
        const previewButton = new Gtk.Button({
            icon_name: 'media-playback-start-symbolic',
            tooltip_text: _('Preview voice'), valign: Gtk.Align.CENTER,
        })
        const primaryButton = new Gtk.Button({
            label: _('Use'), valign: Gtk.Align.CENTER, hexpand: true,
        })
        const menuButton = new Gtk.MenuButton({
            icon_name: 'view-more-symbolic',
            tooltip_text: _('More actions'), valign: Gtk.Align.CENTER,
        })
        const popover = new Gtk.Popover()
        const popoverBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 6,
            margin_top: 6, margin_bottom: 6, margin_start: 6, margin_end: 6,
        })
        const removeButton = new Gtk.Button({
            label: _('Remove Voice'), css_classes: ['destructive-action'],
            halign: Gtk.Align.START,
        })
        const detailsButton = new Gtk.Button({
            label: _('Details'), halign: Gtk.Align.START,
        })
        const resetNarratorButton = new Gtk.Button({
            label: _('Reset to Default Narrator'), halign: Gtk.Align.START,
            visible: false,
        })
        popoverBox.append(removeButton)
        popoverBox.append(detailsButton)
        popoverBox.append(resetNarratorButton)
        popover.set_child(popoverBox)
        menuButton.set_popover(popover)
        actions.append(previewButton)
        actions.append(primaryButton)
        actions.append(menuButton)
        content.append(actions)

        const progress = new Gtk.ProgressBar({
            visible: false, show_text: true, text: _('Downloading…'),
        })
        content.append(progress)
        const backgroundHint = new Gtk.Label({
            label: _('You can close this window while the download continues.'),
            wrap: true, xalign: 0, visible: false, max_width_chars: 60,
            css_classes: ['dim-label'],
        })
        content.append(backgroundHint)
        const errorLabel = new Gtk.Label({
            wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR, xalign: 0,
            visible: false, css_classes: ['error'], max_width_chars: 60,
        })
        content.append(errorLabel)
        toolbar.content = new Gtk.ScrolledWindow({
            child: content, hscrollbar_policy: Gtk.PolicyType.NEVER,
        })
        this.child = toolbar
        this.#ui = {
            previewButton, primaryButton, menuButton, removeButton,
            detailsButton, resetNarratorButton, progress, errorLabel,
            backgroundHint,
        }

        previewButton.connect('clicked', () => { this.#togglePreview() })
        primaryButton.connect('clicked', () => this.#primaryAction())
        removeButton.connect('clicked', () => {
            const item = this.#selectedItem()
            if (item) this.#confirmRemove(item)
        })
        detailsButton.connect('clicked', () => this.#showDetails())
        resetNarratorButton.connect('clicked', () => this.#resetNarrator())
        this.#unsubscribe = jobs.subscribe(() => {
            if (!this.#closed) this.#refresh()
        })
        this.#refresh()

        this.connect('closed', () => {
            this.#closed = true
            this.#unsubscribe?.()
            this.#unsubscribe = null
            this.#cancellable?.cancel()
            this.#stopPreview().catch(() => {})
            // Pack files may still be mutating; the mutation gate must
            // outlive pending download/repair/use work before readers start.
            Promise.resolve(this.#operationPromise).catch(() => {})
                .then(() => this.#releaseLease())
        })
    }

    #pickRecommended(packs, language) {
        const primary = (language || 'en').toLowerCase().split(/[-_]/)[0]
        return packs.find(p => p.default)?.id
            ?? packs.find(p => p.languages.includes(primary))?.id
            ?? packs[0]?.id
            ?? null
    }

    #selectedItem() {
        return this.#selectedId ? this.#items.get(this.#selectedId) : null
    }

    // Move the narrator combo without treating the move as a user change.
    #setNarratorCombo(sid) {
        this.#updatingNarrator = true
        this.#narrator.combo.selected = sid
        this.#updatingNarrator = false
    }

    #resetNarrator() {
        if (this.#storedSid === null) return
        this.#storedSid = null
        this.#pendingSid = null
        this.#refresh()
        this.emit('narrator-reset')
        // the global default is read at reset time, not captured in the
        // constructor: a change while the dialog is open is honored
        const globalSid = this.#getGlobalSid()
        this.#appliedSid = globalSid
        this.#setNarratorCombo(globalSid)
    }

    // The viewer applies narrator state elsewhere and tells this dialog
    // quietly: move the combo to the effective SID, refresh reset
    // sensitivity, emit nothing. A pending user change is kept.
    refreshNarrator(effectiveSid, storedSid) {
        this.#storedSid = storedSid ?? null
        if (this.#pendingSid === null) {
            this.#appliedSid = effectiveSid
            this.#setNarratorCombo(effectiveSid)
        }
        this.#refresh()
    }

    #select(id) {
        if (this.#closed || this.#selectedId === id) return
        if (this.#previewing) this.#stopPreview().catch(() => {})
        this.#selectedId = id
        this.#refresh()
    }

    #statusText(item) {
        if (item.state === 'downloading') return _('Downloading…')
        if (item.state === 'verifying') return _('Verifying…')
        if (item.state === 'previewing') return _('Previewing…')
        if (item.state === 'failed') return _('Failed')
        if (item.state === 'invalid') return _('Invalid')
        if (item.ready) return _('Ready')
        if (item.state === 'installed') return _('Installed')
        return ''
    }

    #syncJobs() {
        for (const item of this.#order) {
            const job = this.#jobs.get(item.pack.id)
            if (!job) continue
            const previous = this.#seenJobs.get(item.pack.id)
            if (previous && previous.status === job.status
                && previous.kind === job.kind && previous.progress === job.progress
                && previous.error === job.error) continue
            this.#seenJobs.set(item.pack.id, job)
            item.lastOperation = job.kind
            item.ready = false
            item.error = null
            item.details = null
            item.backendInvalid = false
            item.progress = job.progress
            if (job.status === 'running') {
                item.state = job.kind === 'repair' ? 'verifying' : 'downloading'
                item.progress ??= 0
            } else if (job.status === 'failed') {
                item.state = 'failed'
                item.error = friendlyError(job.error)
                item.details = technicalDetails(job.error)
            } else if (job.status === 'installed') {
                item.state = 'installed'
                item.candidateFlag = job.kind === 'download'
            } else {
                item.state = this.#operations.getPackState(item.pack).status
            }
        }
    }

    #refresh() {
        this.#syncJobs()
        const sharedJob = this.#jobs.active
        for (const item of this.#order) {
            const { pack, row, recommended, candidate, check } = item
            if (!transientStates.has(item.state)) {
                const base = this.#operations.getPackState(pack)
                if (base.status === 'invalid') {
                    item.state = 'invalid'
                    item.ready = false
                    item.backendInvalid = false
                    if (!item.error) {
                        item.error = _('This voice is damaged. Repair or download it again.')
                        item.details = base.message ?? null
                    }
                } else if (base.status === 'installed') {
                    item.state = 'installed'
                    item.error = null
                    item.details = null
                    item.backendInvalid = false
                } else {
                    item.state = 'missing'
                    item.ready = false
                    item.error = null
                    item.details = null
                    item.backendInvalid = false
                }
            }
            const summary = `${languageSummary(pack)} · ${pack.sizeMB} MB`
            const status = this.#statusText(item)
            row.subtitle = status ? `${summary} · ${status}` : summary
            recommended.visible = this.#recommendedId === pack.id
            candidate.visible = item.candidateFlag && !item.ready
            check.visible = this.#selectedId === pack.id
            row.activatable = !this.#operation || this.#operation === 'preview'
        }

        const selected = this.#selectedItem()
        // the narrator choice, and its reset, exist only for Supertonic;
        // reset sensitivity follows the stored book SID alone
        const narratorPack = this.#selectedId === 'supertonic'
        this.#narrator.group.visible = narratorPack
        const resetNarrator = this.#ui.resetNarratorButton
        resetNarrator.visible = narratorPack
        resetNarrator.sensitive = this.#storedSid !== null

        const preview = this.#ui.previewButton
        const primary = this.#ui.primaryButton
        const menu = this.#ui.menuButton
        const remove = this.#ui.removeButton
        const details = this.#ui.detailsButton
        const progress = this.#ui.progress
        const errorLabel = this.#ui.errorLabel

        const installed = selected
            && (selected.state === 'installed'
                || (selected.state === 'failed'
                    && selected.lastOperation === 'use'))
        preview.visible = !!selected
        // The Stop affordance must stay clickable while a preview runs.
        preview.sensitive = !!selected
            && (this.#previewing
                || (!sharedJob && installed && (!this.#operation
                    || this.#operation === 'preview')))
        preview.label = this.#previewing ? _('Stop') : _('Preview')
        preview.icon_name = this.#previewing
            ? 'media-playback-stop-symbolic'
            : 'media-playback-start-symbolic'
        preview.tooltip_text = this.#previewing
            ? _('Stop preview') : _('Preview voice')

        primary.remove_css_class('suggested-action')
        primary.remove_css_class('destructive-action')
        const action = selected
            ? this.#primaryActionFor(selected)
            : { label: _('Use'), sensitive: false }
        primary.label = action.label
        primary.sensitive = action.sensitive
        if (action.suggested) primary.add_css_class('suggested-action')
        if (action.destructive) primary.add_css_class('destructive-action')

        menu.sensitive = !!selected && !this.#operation && !sharedJob
        remove.sensitive = !!selected && installed && !this.#operation && !sharedJob
        details.sensitive = !!selected && (!!selected.error || !!selected.details)

        const busy = this.#operation === 'download'
            || this.#operation === 'verify' || this.#operation === 'repair'
            || sharedJob?.packId === selected?.pack.id
        this.#ui.backgroundHint.visible = !!sharedJob
        progress.visible = busy && !!selected && selected.progress != null
        if (progress.visible) {
            progress.fraction = selected.progress ?? 0
            progress.text = this.#operation === 'verify' ? _('Verifying…')
                : sharedJob?.kind === 'repair' ? _('Repairing…')
                : selected.progress === 1 ? _('Installing…')
                : _('Downloading…')
        }
        errorLabel.visible = !!(selected && selected.error)
        if (errorLabel.visible) errorLabel.label = selected.error
    }

    #primaryActionFor(item) {
        const sharedJob = this.#jobs.active
        if (sharedJob)
            return sharedJob.packId === item.pack.id
                ? { label: _('Cancel'), sensitive: true, kind: 'cancel' }
                : { label: _('Working…'), sensitive: false, kind: 'none' }
        if (this.#operation && this.#operation !== 'preview') {
            if (this.#operation === 'download' && this.#cancellable)
                return { label: _('Cancel'), sensitive: true, kind: 'cancel' }
            return { label: _('Working…'), sensitive: false, kind: 'none' }
        }
        if (this.#previewing)
            return { label: _('Use'), sensitive: false, kind: 'none' }
        switch (item.state) {
        case 'missing':
            return { label: _('Download'), sensitive: true,
                suggested: true, kind: 'download' }
        case 'invalid':
            return { label: _('Repair'),
                sensitive: typeof this.#operations.repairPack === 'function',
                suggested: true, kind: 'repair' }
        case 'failed':
            if (item.lastOperation === 'download')
                return { label: _('Retry Download'), sensitive: true,
                    suggested: true, kind: 'download' }
            if (item.lastOperation === 'repair')
                return { label: _('Retry Repair'), sensitive: true,
                    suggested: true, kind: 'repair' }
            if (item.lastOperation === 'remove')
                return { label: _('Retry Remove'), sensitive: true,
                    destructive: true, kind: 'remove' }
            if (item.lastOperation === 'use')
                return { label: item.backendInvalid ? _('Repair') : _('Retry'),
                    sensitive: item.backendInvalid
                        ? typeof this.#operations.repairPack === 'function'
                        : true,
                    suggested: true,
                    kind: item.backendInvalid ? 'repair' : 'retry' }
            return { label: _('Retry'), sensitive: true,
                suggested: true, kind: 'retry' }
        case 'installed':
            return { label: _('Use'), sensitive: true,
                suggested: true, kind: 'use' }
        default:
            return { label: _('Use'), sensitive: false, kind: 'none' }
        }
    }

    #primaryAction() {
        const item = this.#selectedItem()
        if (!item || this.#closed) return
        const action = this.#primaryActionFor(item)
        if (!action.sensitive) return
        switch (action.kind) {
        case 'download':
            this.#download(item).catch(() => {})
            break
        case 'cancel':
            if (this.#jobs.active) this.#jobs.cancel(this.#jobs.active.packId)
            else this.#cancellable?.cancel()
            break
        case 'use':
            this.#use(item).catch(() => {})
            break
        case 'repair':
            this.#confirmRepair(item)
            break
        case 'remove':
            this.#confirmRemove(item)
            break
        case 'retry':
            this.#retry(item).catch(() => {})
            break
        }
    }

    #retry(item) {
        if (item.lastOperation === 'download') return this.#download(item)
        if (item.lastOperation === 'repair') return this.#confirmRepair(item)
        if (item.lastOperation === 'remove') return this.#confirmRemove(item)
        if (item.lastOperation === 'use') return this.#use(item)
        if (item.lastOperation === 'preview') return this.#togglePreview()
        return this.#download(item)
    }

    #download(item) {
        if (this.#operation || this.#closed || this.#jobs.active)
            return Promise.resolve()
        return this.#jobs.start(item.pack)
    }

    async #use(item) {
        if (this.#operation || this.#closed || this.#jobs.active) return
        this.#operation = 'use'
        this.#cancellable = new Gio.Cancellable()
        const cancellable = this.#cancellable
        item.error = null
        item.details = null
        item.backendInvalid = null
        this.#refresh()
        this.#operationPromise = (async () => {
            try {
                if (this.#previewing) await this.#stopPreview()
                if (this.#closed) return
                const ensure = this.#operations.ensurePackReady
                    ?? (await import('./voice-pack-validation.js')
                        .catch(() => null))?.ensurePackReady
                if (typeof ensure === 'function')
                    await ensure(item.pack, { cancellable })
                else if (!verifyPack(item.pack))
                    throw new Error(_('The voice pack is not installed.'))
                if (cancellable.is_cancelled() || this.#closed) return
                item.state = 'installed'
                item.ready = true
                item.lastOperation = 'use'
                if (this.#pendingSid !== null && item.pack.id === 'supertonic') {
                    this.emit('narrator-selected', this.#pendingSid)
                    this.#pendingSid = null
                }
                this.emit('voice-selected', item.pack)
            } catch (error) {
                if (!cancellable.is_cancelled()) {
                    item.state = 'failed'
                    item.lastOperation = 'use'
                    item.error = friendlyError(error)
                    item.details = technicalDetails(error)
                    item.backendInvalid = error?.code === 'invalid-pack'
                }
            } finally {
                if (this.#cancellable === cancellable) this.#cancellable = null
                this.#operation = null
                this.#operationPromise = null
                if (!this.#closed) this.#refresh()
            }
        })()
        await this.#operationPromise
    }

    #repair(item) {
        if (this.#operation || this.#closed || this.#jobs.active)
            return Promise.resolve()
        return this.#jobs.start(item.pack, 'repair')
    }

    async #remove(item) {
        if (this.#operation || this.#closed || this.#jobs.active) return
        this.#operation = 'remove'
        this.#cancellable = new Gio.Cancellable()
        const cancellable = this.#cancellable
        item.error = null
        item.details = null
        this.#refresh()
        this.#operationPromise = (async () => {
            let leased = false
            try {
                if (this.#previewing) await this.#stopPreview()
                if (this.#closed) return
                leased = await this.#acquireLease()
                if (this.#closed) return
                deletePack(item.pack.id)
                if (this.#closed) return
                item.state = 'missing'
                item.ready = false
                item.candidateFlag = false
                item.lastOperation = 'remove'
                if (this.#selectedId === item.pack.id)
                    this.#selectedId = this.#recommendedId
                this.emit('voice-removed', item.pack.id)
            } catch (error) {
                if (!cancellable.is_cancelled()) {
                    item.state = 'failed'
                    item.lastOperation = 'remove'
                    item.error = friendlyError(error)
                    item.details = technicalDetails(error)
                }
            } finally {
                if (leased) this.#releaseLease()
                if (this.#cancellable === cancellable) this.#cancellable = null
                this.#operation = null
                this.#operationPromise = null
                if (!this.#closed) this.#refresh()
            }
        })()
        await this.#operationPromise
    }

    async #acquireLease() {
        const prepare = this.#operations.prepareVoicePackChange
            ?? (await import('./voice-daemon.js')
                .catch(() => null))?.prepareVoicePackChange
        if (typeof prepare !== 'function')
            throw new Error(_('Voice backend is not ready for changes.'))
        this.#lease = await prepare()
        return true
    }

    #releaseLease() {
        const release = this.#lease
        this.#lease = null
        if (typeof release === 'function') {
            try { release() } catch { /* already released */ }
        }
    }

    async #togglePreview() {
        if (this.#closed) return
        if (this.#previewing) {
            await this.#stopPreview()
            return
        }
        const item = this.#selectedItem()
        if (!item || this.#operation || this.#jobs.active) return
        const base = this.#operations.getPackState(item.pack)
        if (base.status !== 'installed') return
        this.#previewing = true
        this.#previewStopped = false
        this.#operation = 'preview'
        item.state = 'previewing'
        item.error = null
        item.details = null
        this.#refresh()
        try {
            await this.#player.play([{ text: item.pack.sample, index: 0 }], {
                pack: item.pack,
                lang: 'en',
                // preview the narrator selection only on Supertonic
                ...(item.pack.id === 'supertonic'
                    ? { voice: this.#narrator.combo.selected } : {}),
                onError: error => {
                    if (this.#closed || this.#previewStopped) return
                    item.state = 'failed'
                    item.lastOperation = 'preview'
                    item.error = friendlyError(error)
                    item.details = technicalDetails(error)
                    this.#refresh()
                },
            })
        } catch (error) {
            if (!this.#closed && !this.#previewStopped) {
                item.state = 'failed'
                item.lastOperation = 'preview'
                item.error = friendlyError(error)
                item.details = technicalDetails(error)
            }
        } finally {
            this.#previewing = false
            this.#previewStopped = false
            if (this.#operation === 'preview') this.#operation = null
            if (!this.#closed) {
                // A preview failure remains actionable; only a settled
                // preview falls back to structural state.
                if (item.state !== 'failed') {
                    const base = this.#operations.getPackState(item.pack)
                    item.state = base.status === 'installed' ? 'installed'
                        : base.status === 'invalid' ? 'invalid' : 'missing'
                }
                this.#refresh()
            }
        }
    }

    async #stopPreview() {
        if (!this.#previewing) return
        this.#previewStopped = true
        try {
            await this.#operations.stopAndWait()
        } catch { /* already stopped */ }
        this.#previewing = false
        if (this.#operation === 'preview') this.#operation = null
        if (!this.#closed) this.#refresh()
    }

    #confirmRemove(item) {
        if (this.#closed) return
        const dialog = new Adw.AlertDialog({
            heading: _('Remove Voice?'),
            body: _('The downloaded model will be deleted. You can download it again later.'),
            close_response: 'cancel', default_response: 'cancel',
        })
        dialog.add_response('cancel', _('Cancel'))
        dialog.add_response('remove', _('Remove'))
        dialog.set_response_appearance(
            'remove', Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.connect('response', (_, response) => {
            if (response !== 'remove') return
            this.#remove(item).catch(() => {})
        })
        dialog.present(this)
    }

    #confirmRepair(item) {
        if (this.#closed) return
        const dialog = new Adw.AlertDialog({
            heading: _('Repair Voice?'),
            body: _('The existing voice files are kept until the replacement downloads and validates.'),
            close_response: 'cancel', default_response: 'cancel',
        })
        dialog.add_response('cancel', _('Cancel'))
        dialog.add_response('repair', _('Repair'))
        dialog.set_response_appearance(
            'repair', Adw.ResponseAppearance.SUGGESTED)
        dialog.connect('response', (_, response) => {
            if (response !== 'repair') return
            this.#repair(item).catch(() => {})
        })
        dialog.present(this)
    }

    #showDetails() {
        const item = this.#selectedItem()
        if (!item || (!item.error && !item.details)) return
        const dialog = new Adw.AlertDialog({
            heading: _('Technical Details'),
            body: item.error ?? '',
            close_response: 'close',
        })
        dialog.add_response('close', _('Close'))
        const label = new Gtk.Label({
            label: item.details ?? _('No additional details.'),
            wrap: true, wrap_mode: Pango.WrapMode.WORD_CHAR,
            xalign: 0, selectable: true, max_width_chars: 60,
        })
        const scroller = new Gtk.ScrolledWindow({
            child: label, min_content_height: 100, max_content_height: 220,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
        })
        dialog.extra_child = scroller
        dialog.present(this)
    }

    get _testState() {
        const selected = this.#selectedItem()
        return {
            selectedId: this.#selectedId,
            recommendedId: this.#recommendedId,
            operation: this.#operation ?? this.#jobs.active?.kind ?? null,
            previewing: this.#previewing,
            leased: !!this.#lease,
            narratorVisible: this.#narrator.group.visible,
            narratorSelected: this.#narrator.combo.selected,
            narratorChoices: this.#narrator.combo.model.get_n_items(),
            items: this.#order.map(item => ({
                id: item.pack.id, state: item.state, ready: item.ready,
                candidate: item.candidateFlag, error: item.error,
                progress: item.progress, lastOperation: item.lastOperation,
            })),
            primary: selected ? this.#primaryActionFor(selected).label : null,
            subtitle: selected ? selected.row.subtitle : null,
            packDir: selected ? packDir(selected.pack.id) : null,
        }
    }

    // Narrow seams for deterministic chooser tests. They call the same
    // production operation paths; only the confirmation dialog is bypassed.
    _testRemove() {
        return this.#remove(this.#selectedItem())
    }

    _testRepair() {
        return this.#repair(this.#selectedItem())
    }

    _testPreview() {
        return this.#togglePreview()
    }

    _testStopPreview() {
        return this.#stopPreview()
    }
})
