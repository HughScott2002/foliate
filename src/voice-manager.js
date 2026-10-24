import Adw from 'gi://Adw'
import Gtk from 'gi://Gtk'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'
import GObject from 'gi://GObject'
import { gettext as _ } from 'gettext'
import { getPacks, verifyPack, download, deletePack, packDir } from './voice-packs.js'
import { LocalTTS } from './local-tts.js'
import { LocalTTSPlayer } from './local-tts-player.js'

export const VoiceManagerDialog = GObject.registerClass({
    Signals: {
        'voice-selected': { param_types: [GObject.TYPE_JSOBJECT] },
        'voice-removed': { param_types: [GObject.TYPE_STRING] },
    },
}, class extends Adw.Dialog {
    #rows = []
    #cancellable = null
    #player = new LocalTTSPlayer({ tts: new LocalTTS() })
    #closed = false
    #previewing = false
    constructor({ packs = getPacks(), language = 'en', selected = null } = {}) {
        super({ title: _('Choose Voice'), content_width: 520, content_height: 520 })
        const toolbar = new Adw.ToolbarView()
        toolbar.add_top_bar(new Adw.HeaderBar())
        const content = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL, spacing: 18,
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
                title: pack.label,
                subtitle: `${pack.sizeMB} MB · ${pack.languages.join(', ')}`,
            })
            const button = new Gtk.Button({ valign: Gtk.Align.CENTER })
            const preview = new Gtk.Button({
                icon_name: 'media-playback-start-symbolic',
                tooltip_text: _('Preview voice'), valign: Gtk.Align.CENTER,
            })
            const remove = new Gtk.Button({
                icon_name: 'user-trash-symbolic', tooltip_text: _('Remove voice'),
                valign: Gtk.Align.CENTER,
            })
            row.add_suffix(preview)
            row.add_suffix(button)
            row.add_suffix(remove)
            const progress = new Gtk.ProgressBar({ visible: false, show_text: true })
            group.add(row)
            group.add(progress)
            const item = { pack, row, button, preview, remove, progress }
            this.#rows.push(item)
            button.connect('clicked', () => {
                if (verifyPack(pack)) this.emit('voice-selected', pack)
                else this.#download(item)
            })
            preview.connect('clicked', () => this.#preview(item))
            remove.connect('clicked', () => this.#confirmRemove(item))
            if (pack.id === selected || (!selected && (
                pack.languages.includes(language) || pack.default)))
                button.add_css_class('suggested-action')
        }
        toolbar.content = new Gtk.ScrolledWindow({ child: content, hscrollbar_policy: Gtk.PolicyType.NEVER })
        this.child = toolbar
        this.#refresh()
        this.connect('closed', () => {
            this.#closed = true
            this.#cancellable?.cancel()
            this.#player.stop()
        })
    }
    #refresh() {
        for (const { pack, row, button, preview, remove } of this.#rows) {
            const installed = verifyPack(pack)
            button.label = installed ? _('Use Voice') : _('Download')
            button.sensitive = !this.#cancellable
            preview.visible = installed
            preview.sensitive = !this.#cancellable && !this.#previewing
            remove.visible = GLib.file_test(packDir(pack.id), GLib.FileTest.IS_DIR)
            remove.sensitive = !this.#cancellable
            row.subtitle = `${pack.sizeMB} MB · ${pack.languages.join(', ')}`
                + (installed ? ` · ${_('Installed')}` : '')
        }
    }
    async #download(item) {
        if (this.#cancellable) return
        this.#player.stop()
        const cancellable = new Gio.Cancellable()
        this.#cancellable = cancellable
        item.progress.visible = true
        item.progress.fraction = 0
        item.progress.text = _('Downloading…')
        this.#refresh()
        try {
            await download(item.pack, fraction => {
                item.progress.fraction = fraction
                item.progress.text = fraction === 1 ? _('Installing…') : _('Downloading…')
            }, cancellable)
            if (!this.#closed) {
                this.#cancellable = null
                this.#refresh()
                this.emit('voice-selected', item.pack)
            }
        } catch (error) {
            if (!cancellable.is_cancelled()) {
                item.progress.text = error.message
                item.row.subtitle = _('Download failed. Check your connection and try again.')
            }
        } finally {
            this.#cancellable = null
            if (!this.#closed) {
                this.#refresh()
                item.progress.visible = !verifyPack(item.pack)
            }
        }
    }
    async #preview(item) {
        if (this.#previewing || this.#cancellable || this.#closed) return
        this.#previewing = true
        this.#refresh()
        const report = error => {
            item.progress.visible = true
            item.progress.text = error.message
        }
        try {
            await this.#player.play([{ text: item.pack.sample, index: 0 }], {
                pack: item.pack, lang: 'en', onError: report,
            })
        } catch (error) { report(error) }
        finally {
            this.#previewing = false
            if (!this.#closed) this.#refresh()
        }
    }
    #confirmRemove(item) {
        const dialog = new Adw.AlertDialog({
            heading: _('Remove Voice?'),
            body: _('The downloaded model will be deleted. You can download it again later.'),
            close_response: 'cancel', default_response: 'cancel',
        })
        dialog.add_response('cancel', _('Cancel'))
        dialog.add_response('remove', _('Remove'))
        dialog.set_response_appearance('remove', Adw.ResponseAppearance.DESTRUCTIVE)
        dialog.connect('response', (_, response) => {
            if (response !== 'remove') return
            this.#player.stop()
            this.emit('voice-removed', item.pack.id)
            try {
                deletePack(item.pack.id)
                this.#refresh()
            } catch (error) {
                item.progress.visible = true
                item.progress.text = error.message
            }
        })
        dialog.present(this)
    }
})
