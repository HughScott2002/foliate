import Gtk from 'gi://Gtk?version=4.0'
import Adw from 'gi://Adw?version=1'
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import Soup from 'gi://Soup?version=3.0'

const tmp = GLib.dir_make_tmp('foliate-voice-ui-XXXXXX')
GLib.setenv('XDG_DATA_HOME', tmp, true)
Gtk.init()
Adw.init()
const { VoiceManagerDialog } = await import('../src/voice-manager.js')
const { verifyPack, deletePack } = await import('../src/voice-packs.js')
const check = (ok, message) => { if (!ok) throw new Error(message) }
const descendants = function* (widget) {
    yield widget
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        yield* descendants(child)
}
GLib.mkdir_with_parents(`${tmp}/fixture`, 0o700)
GLib.file_set_contents(`${tmp}/fixture/model.onnx`, 'fixture')
Gio.Subprocess.new(['tar', '-cjf', `${tmp}/pack.tar.bz2`, '-C', tmp, 'fixture'],
    Gio.SubprocessFlags.NONE).wait_check(null)
const [bytes] = Gio.File.new_for_path(`${tmp}/pack.tar.bz2`).load_bytes(null)
const server = new Soup.Server()
server.add_handler('/voice', (_, message) => {
    message.set_status(200, null)
    message.set_response('application/octet-stream', Soup.MemoryUse.COPY, bytes.get_data())
})
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY)
const pack = {
    id: 'ui-fixture', label: 'Fixture', sizeMB: 1, languages: ['en'],
    url: server.get_uris()[0].to_string() + 'voice',
    sha256: GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes),
    expectedFiles: ['model.onnx'],
}
const dialog = new VoiceManagerDialog({ packs: [pack], language: 'en' })
const window = new Adw.Window()
window.present()
dialog.present(window)
let selected
dialog.connect('voice-selected', (_, value) => selected = value)
const download = [...descendants(dialog.child)].find(w =>
    w instanceof Gtk.Button && w.label === 'Download')
check(download, 'download button not discoverable')
download.emit('clicked')
const deadline = Date.now() + 10000
while (!selected && Date.now() < deadline) await new Promise(resolve =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 10, () => (resolve(), GLib.SOURCE_REMOVE)))
check(selected?.id === 'ui-fixture' && verifyPack(pack), 'download did not install and select voice')
const labels = [...descendants(dialog.child)].filter(w => w instanceof Gtk.Label)
check(labels.some(w => w.label.includes('Installed')), 'download did not update installed state')
dialog.close()
window.destroy()
server.disconnect()
deletePack(pack.id)
print('Voice manager download-to-installed test passed')
