import Gtk from 'gi://Gtk?version=4.0'
import Adw from 'gi://Adw?version=1'
import Gio from 'gi://Gio'
import GLib from 'gi://GLib'

Gtk.init()
Adw.init()
globalThis.pkg = {
    name: 'com.github.johnfactotum.Foliate',
    moduleuri: path =>
        Gio.File.new_for_path(`${GLib.get_current_dir()}/src/${path}`).get_uri(),
    configpath: name =>
        Gio.File.new_for_path(
            `${GLib.get_current_dir()}/data/${name}`).get_path(),
    datapath: name =>
        `${GLib.build_filenamev([
            GLib.get_user_data_dir(), 'com.github.johnfactotum.Foliate', name,
        ])}`,
    modulepath: path =>
        Gio.File.new_for_path(`${GLib.get_current_dir()}/src/${path}`).get_path(),
}

const { narratorLabel } = await import('../src/voice-packs.js')
const utils = await import('../src/utils.js')
const check = (ok, message) => { if (!ok) throw new Error(message) }

// --- schema: key exists, is uint, defaults to 0, rejects out-of-range ---

const settings = new Gio.Settings({
    schema: 'com.github.johnfactotum.Foliate.viewer',
})
const schemaKey = settings.settings_schema.get_key('tts-supertonic-sid')
check(schemaKey.get_value_type().equal(GLib.VariantType.new('u')),
    'tts-supertonic-sid must be uint')
check(settings.get_uint('tts-supertonic-sid') === 0,
    'tts-supertonic-sid must default to 0')
const range = schemaKey.get_range().get_child_value(1).recursiveUnpack()
check(range[0] === 0 && range[1] === 9,
    'tts-supertonic-sid range must be 0..9')
check(settings.set_uint('tts-supertonic-sid', 5),
    'tts-supertonic-sid must accept 5')
check(!settings.set_uint('tts-supertonic-sid', 10)
    && settings.get_uint('tts-supertonic-sid') === 5,
'tts-supertonic-sid must reject 10 and keep the stored value 5')
check(!settings.set_value('tts-supertonic-sid', GLib.Variant.new_int32(-1))
    && settings.get_uint('tts-supertonic-sid') === 5,
'tts-supertonic-sid must reject -1 and keep the stored value 5')
check(new Gio.Settings({
    schema: 'com.github.johnfactotum.Foliate.viewer',
}).get_uint('tts-supertonic-sid') === 5,
'tts-supertonic-sid must persist 5 across settings instances')

// --- NarrationSettings data class ---

const bookViewer = await import('../src/book-viewer.js')
const { NarrationSettings, ViewPreferencesWindow } = bookViewer
check(NarrationSettings, 'NarrationSettings must be exported from book-viewer.js')
const narration = new NarrationSettings({ 'default': 0 })
check(narration['default'] === 0, 'NarrationSettings default must be a uint at 0')
narration['default'] = 5
check(narration['default'] === 5, 'NarrationSettings default must be settable')

// --- real GSettings binding: tts-supertonic-sid <-> default ---

const bound = new NarrationSettings({ 'default': 0 })
settings.set_uint('tts-supertonic-sid', 7)
bound.bindSettings()
check(bound['default'] === 7,
    'bindSettings must sync-create from the persisted tts-supertonic-sid (7)')
bound['default'] = 3
check(settings.get_uint('tts-supertonic-sid') === 3,
    'changing default must write tts-supertonic-sid (3)')
settings.set_uint('tts-supertonic-sid', 8)
check(bound['default'] === 8,
    'changing tts-supertonic-sid must update default (8)')
bound.unbindSettings()
settings.set_uint('tts-supertonic-sid', 9)
check(bound['default'] === 8,
    'after unbindSettings, GSettings changes must not reach default (stays 8)')
settings.set_uint('tts-supertonic-sid', 0)

// --- Preferences dialog: Narration page with Default Narrator combo row ---

// Stand-ins with the same keys/behavior as the book-viewer settings models so
// the dialog constructor can do its normal bindings without a BookViewer.
const TestViewSettings = utils.makeDataClass('TestViewSettings', {
    'line-height': 'double',
    'justify': 'boolean',
    'hyphenate': 'boolean',
    'gap': 'double',
    'max-inline-size': 'uint',
    'max-block-size': 'uint',
    'max-column-count': 'uint',
    'animated': 'boolean',
    'override-font': 'boolean',
    'theme': 'string',
})
const TestFontSettings = utils.makeDataClass('TestFontSettings', {
    'serif': 'string',
    'sans-serif': 'string',
    'monospace': 'string',
    'default': 'uint',
    'default-size': 'double',
    'minimum-size': 'double',
})

const win = new ViewPreferencesWindow({
    view_settings: new TestViewSettings({ theme: 'default' }),
    font_settings: new TestFontSettings(),
    narration_settings: narration,
})

const combo = win._default_narrator

// end-to-end: real GSettings -> data class -> combo row (SYNC_CREATE binds at
// construction and later here, and forwards through the dialog binding)
narration.bindSettings()
narration['default'] = 0
check(combo.selected === 0, 'bound default 0 must select row 0')

let page = combo
while (page && !(page instanceof Adw.PreferencesPage)) page = page.parent
check(page && page.icon_name === 'audio-speakers-symbolic',
    'combo row must live on a page with the audio-speakers icon')
check(page.title === 'Narration', 'narration page must be titled Narration')
check(combo.title === 'Default Narrator',
    'the row must be titled Default Narrator')

const model = combo.model
check(model instanceof Gtk.StringList, 'combo model must be a GtkStringList')
check(model.get_n_items() === 10, 'combo must hold exactly ten narrators')
check(model.get_string(0) === narratorLabel(0) && model.get_string(0).includes('Amy'),
    'row 0 must be the Amy label in SID order')
check(model.get_string(9) === narratorLabel(9) && model.get_string(9).includes('Theo'),
    'row 9 must be the Theo label in SID order')

// middle binding: row 5 <-> SID 5 <-> Leo label, in both directions
narration['default'] = 0
combo.selected = 5
check(narration['default'] === 5, 'selecting row 5 must persist 5')
check(settings.get_uint('tts-supertonic-sid') === 5,
    'selecting row 5 must write 5 to tts-supertonic-sid')
check(model.get_string(combo.selected) === narratorLabel(5)
    && narratorLabel(5).includes('Leo'),
'row 5 must show Leo’s label')
narration['default'] = 5
check(combo.selected === 5, 'setting 5 must select row 5')
narration['default'] = 0
check(combo.selected === 0, 'setting 0 must select row 0')
narration.unbindSettings()
settings.set_uint('tts-supertonic-sid', 0)

print('view-preferences-test passed')
