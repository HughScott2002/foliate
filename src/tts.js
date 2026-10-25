import Gtk from 'gi://Gtk'
import GObject from 'gi://GObject'
import { gettext as _ } from 'gettext'

import * as utils from './utils.js'
import { SSIPClient } from './speech.js'
import { LocalTTS } from './local-tts.js'
import { LocalTTSPlayer } from './local-tts-player.js'
import { getInstalledPacks } from './voice-packs.js'

const ssip = new SSIPClient()

export const TTSBox = GObject.registerClass({
    GTypeName: 'FoliateTTSBox',
    Template: pkg.moduleuri('ui/tts-box.ui'),
    Signals: {
        'init': { return_type: GObject.TYPE_JSOBJECT },
        'start': { return_type: GObject.TYPE_JSOBJECT },
        'resume': { return_type: GObject.TYPE_JSOBJECT },
        'backward': { return_type: GObject.TYPE_JSOBJECT },
        'forward': { return_type: GObject.TYPE_JSOBJECT },
        'backward-paused': {},
        'forward-paused': {},
        'highlight': {
            param_types: [GObject.TYPE_JSOBJECT],
            return_type: GObject.TYPE_JSOBJECT,
        },
        'next-section': { return_type: GObject.TYPE_JSOBJECT },
        'parse': {
            param_types: [GObject.TYPE_STRING],
            return_type: GObject.TYPE_JSOBJECT,
        },
        'clear-highlight': {},
        'voices-requested': { param_types: [GObject.TYPE_BOOLEAN] },
        'state-changed': { param_types: [GObject.TYPE_STRING] },
    },
    InternalChildren: [
        'tts-rate-scale', 'tts-pitch-scale',
        'media-buttons', 'play-button',
        'system-controls', 'local-controls', 'backend-dropdown',
        'local-rate', 'voice-label', 'manage-voices-button',
    ],
}, class extends Gtk.Box {
    #state = 'stopped'
    #generation = 0
    #settings = utils.settings('viewer')
    #backend = this.#settings?.get_string('tts-backend') ?? 'local'
    #player = new LocalTTSPlayer({ tts: new LocalTTS() })
    language = 'en'
    pack = null
    defaultWidget = this._play_button
    constructor(params) {
        super(params)
        this.insert_action_group('tts', utils.addMethods(this, {
            actions: ['play', 'backward', 'forward', 'stop'],
        }))
        utils.setDirection(this._media_buttons, Gtk.TextDirection.LTR)

        this.#connectScale(this._tts_rate_scale, ssip.setRate.bind(ssip))
        this.#connectScale(this._tts_pitch_scale, ssip.setPitch.bind(ssip))
        this._backend_dropdown.selected = this.backend === 'local' ? 0 : 1
        this._backend_dropdown.connect('notify::selected', dropdown => {
            this.stop()
            this.#backend = dropdown.selected === 0 ? 'local' : 'speechd'
            this.#settings?.set_string('tts-backend', this.backend)
            this.#syncBackend()
        })
        this._local_rate.connect('value-changed', spin =>
            this.#player.setRate(spin.value))
        this._manage_voices_button.connect('clicked', () => this.emit('voices-requested', false))
        this.#syncBackend()
    }
    get backend() { return this.#backend }
    get rateAdjustment() { return this._local_rate.adjustment }
    #syncBackend() {
        this._system_controls.visible = this.backend === 'speechd'
        this._local_controls.visible = this.backend === 'local'
    }
    setPack(pack) {
        this.stop()
        this.pack = pack
        this._voice_label.label = pack?.label ?? _('Download a voice to get started')
    }
    #connectScale(scale, f) {
        scale.connect('value-changed', scale => {
            const shouldResume = this.state === 'playing'
            this.state = 'paused'
            ssip.stop()
                .then(() => f(Math.trunc(scale.get_value())))
                .then(() => shouldResume ? this.start() : null)
                .catch(e => this.error(e))
        })
    }
    get state() {
        return this.#state
    }
    set state(state) {
        this.#state = state
        this._play_button.icon_name = state === 'playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic'
        this.emit('state-changed', state)
    }
    #init() {
        return ssip.stop().then(() => this.emit('init'))
    }
    async #speak(ssml) {
        this.state = 'playing'
        ssml = await ssml
        if (!ssml && await this.emit('next-section')) return this.forward()
        const iter = await ssip.speak(ssml)
        let state
        for await (const { mark, message } of iter) {
            if (mark) await this.emit('highlight', mark)
            else state = message
        }
        if (state === 'END') this.forward()
    }
    speak(ssml) {
        if (this.backend === 'local') return this.#beginLocal(null, ssml)
        this.#init().then(() => this.#speak(ssml)).catch(e => this.error(e))
    }
    play() {
        if (this.#state !== 'playing') this.start()
        else this.pause()
    }
    start() {
        if (this.backend === 'local') {
            if (this.state === 'paused') {
                this.#player.resume()
                this.state = 'playing'
                return
            }
            return this.#beginLocal('start')
        }
        this.#init()
            .then(() => this.#speak(this.state === 'paused'
                ? this.emit('resume')
                : this.emit('start')))
            .catch(e => this.error(e))
    }
    pause() {
        this.state = 'paused'
        if (this.backend === 'local') return this.#player.pause()
        ssip.stop().catch(e => this.error(e))
    }
    stop() {
        ++this.#generation
        this.#player.stop()
        this.state = 'stopped'
        this.emit('clear-highlight')
        if (this.backend === 'speechd') ssip.stop().catch(e => console.debug(e))
    }
    backward() {
        if (this.backend === 'local') return this.#beginLocal('backward')
        this.#init()
            .then(() => this.state === 'playing'
                ? this.#speak(this.emit('backward'))
                : (this.state = 'paused', this.emit('backward-paused')))
            .catch(e => this.error(e))
    }
    forward() {
        if (this.backend === 'local') return this.#beginLocal('forward')
        this.#init()
            .then(() => this.state === 'playing'
                ? this.#speak(this.emit('forward'))
                : (this.state = 'paused', this.emit('forward-paused')))
            .catch(e => this.error(e))
    }
    error(e) {
        this.stop()
        console.error(e)
        this.root.error(_('Text-to-Speech Error'),
            this.backend === 'local' ? e.message
            : _('Make sure Speech Dispatcher is installed and working on your system'))
    }
    async #beginLocal(command, arg) {
        if (!this.pack || !getInstalledPacks().some(x => x.id === this.pack.id)) {
            this.emit('voices-requested', true)
            return
        }
        const generation = ++this.#generation
        this.#player.stop()
        this.state = 'playing'
        try {
            await this.emit('init')
            if (generation !== this.#generation) return
            const initial = command ? await this.emit(command) : arg
            if (generation !== this.#generation) return
            await this.#speakStream(initial, generation)
        } catch (e) {
            if (generation === this.#generation) this.error(e)
        }
    }
    // One continuous sentence stream across every block and section of the
    // book. `source()` pulls the next sentence, fetching blocks from the
    // reader as they are needed — but the player pulls it ahead of
    // playback, so a block's sentences are already synthesized while the
    // previous block is still being read aloud. When the current section is
    // exhausted the source advances to the next section in place, so the
    // boundary is seamless too.
    //
    // Each block carries a `seq`: the reader snapshots that block's
    // highlight ranges under the same seq, so a sentence is highlighted from
    // its own block's ranges even though lookahead has advanced the iterator.
    async #speakStream(initial, generation) {
        const buffer = []
        const addBlock = async blk => {
            const parsed = await this.emit('parse', blk.ssml)
            if (generation !== this.#generation) return false
            const lang = (parsed.language || this.language).split('-')[0]
            for (const s of parsed.sentences)
                buffer.push({ text: s.text, index: s.index, lang, seq: blk.seq })
            return true
        }
        if (initial) {
            const blk = typeof initial === 'string' ? { ssml: initial, seq: -1 } : initial
            if (blk.ssml && !await addBlock(blk)) return
        }
        const source = async () => {
            while (buffer.length === 0) {
                if (generation !== this.#generation) return null
                let blk = await this.emit('forward')
                if (generation !== this.#generation) return null
                if (!blk) {
                    const advanced = await this.emit('next-section')
                    if (generation !== this.#generation) return null
                    if (!advanced) return null
                    blk = await this.emit('forward')
                    if (generation !== this.#generation || !blk) return null
                }
                if (!await addBlock(blk)) return null
            }
            return buffer.shift()
        }
        let failed = false
        await this.#player.playStream(source, {
            pack: this.pack,
            rate: this._local_rate.value,
            onMark: entry => {
                if (this.state === 'paused') this.#player.pause()
                if (generation === this.#generation)
                    Promise.resolve(this.emit('highlight',
                        { seq: entry?.seq, mark: String(entry?.index) }))
                        .catch(e => {
                            if (generation === this.#generation) this.error(e)
                        })
            },
            onError: e => {
                failed = true
                if (generation === this.#generation) this.error(e)
            },
        })
        if (!failed && generation === this.#generation) this.stop()
    }
    kill() {
        ++this.#generation
        this.#player.stop()
        this.emit = () => {}
        if (this.state === 'playing') ssip.stop().catch(e => console.error(e))
    }
})


GObject.registerClass({
    GTypeName: 'FoliateMediaOverlayBox',
    Template: pkg.moduleuri('ui/media-overlay-box.ui'),
    Properties: utils.makeParams({
        'rate': 'double',
        'volume': 'double',
    }),
    Signals: {
        'start': {},
        'pause': {},
        'resume': {},
        'stop': {},
        'backward': {},
        'forward': {},
        'state-changed': { param_types: [GObject.TYPE_STRING] },
    },
    InternalChildren: [
        'volume-scale',
        'media-buttons', 'play-button',
    ],
}, class extends Gtk.Box {
    #state = 'stopped'
    defaultWidget = this._play_button
    constructor(params) {
        super(params)
        this.set_property('rate', 1)
        const actionGroup = utils.addMethods(this, {
            actions: ['play', 'backward', 'forward', 'stop'],
        })
        utils.addPropertyActions(this, ['rate'], actionGroup)
        this.insert_action_group('media-overlay', actionGroup)

        utils.setDirection(this._media_buttons, Gtk.TextDirection.LTR)

        // GtkScale, y u no implement GtkActionable?
        this._volume_scale.connect('value-changed', scale =>
            this.set_property('volume', scale.get_value()))
    }
    get state() {
        return this.#state
    }
    set state(state) {
        this.#state = state
        this._play_button.icon_name = state === 'playing'
            ? 'media-playback-pause-symbolic'
            : 'media-playback-start-symbolic'
        this.emit('state-changed', state)
    }
    play() {
        if (this.#state !== 'playing') this.start()
        else this.pause()
    }
    start() {
        if (this.state === 'paused') this.emit('resume')
        else this.emit('start')
        this.state = 'playing'
    }
    pause() {
        this.state = 'paused'
        this.emit('pause')
    }
    stop() {
        this.state = 'stopped'
        this.emit('stop')
    }
    backward() {
        if (this.state === 'stopped') this.state = 'playing'
        this.emit('backward')
    }
    forward() {
        if (this.state === 'stopped') this.state = 'playing'
        this.emit('forward')
    }
})
