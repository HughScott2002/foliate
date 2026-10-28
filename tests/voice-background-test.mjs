import Gtk from 'gi://Gtk?version=4.0'
import Adw from 'gi://Adw?version=1'
import GLib from 'gi://GLib'
import { VoicePackJobs } from '../src/voice-pack-jobs.js'
import { VoiceManagerDialog } from '../src/voice-manager.js'

Gtk.init()
Adw.init()
const check = (ok, message) => { if (!ok) throw new Error(message) }
const wait = ms => new Promise(resolve => GLib.timeout_add(
    GLib.PRIORITY_DEFAULT, ms, () => (resolve(), GLib.SOURCE_REMOVE)))
const until = async predicate => {
    for (let i = 0; i < 300; i++) {
        if (predicate()) return
        await wait(10)
    }
    throw new Error('Timed out waiting for background transfer state')
}
const widgets = function* (widget) {
    yield widget
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        yield* widgets(child)
}
const button = (dialog, label) => [...widgets(dialog.child)]
    .find(widget => widget instanceof Gtk.Button && widget.label === label)
const pack = { id: 'background-fixture', label: 'Background fixture',
    languages: ['en'], sizeMB: 1, expectedFiles: ['model.onnx'] }
let finish, reportProgress, installed = false
const jobs = new VoicePackJobs({
    prepareVoicePackChange: async () => () => {},
    download: async (_, progress, cancellable) => {
        reportProgress = progress
        progress(0.25)
        await new Promise((resolve, reject) => {
            finish = () => { installed = true; resolve() }
            cancellable.connect(() => reject(new Error('cancelled')))
        })
    },
})
const options = { packs: [pack], jobs, operations: {
    getPackState: () => ({ status: installed ? 'installed' : 'missing' }),
    ensurePackReady: async () => {},
} }
const nav = new Gtk.Button({ label: 'Next page' })
const window = new Adw.Window({ content: nav,
    default_width: 360, default_height: 640 })
window.present()
let dialog = new VoiceManagerDialog(options)
dialog.present(window)
try {
    const pending = jobs.start(pack)
    await until(() => jobs.active?.progress === 0.25)
    check(button(dialog, 'Cancel')?.sensitive,
        'An existing shared transfer must expose Cancel in the chooser')
    const bar = [...widgets(dialog.child)].find(w => w instanceof Gtk.ProgressBar)
    let lateUpdates = 0
    dialog.close()
    await until(() => window.get_visible_dialog() === null)
    bar.connect('notify::fraction', () => lateUpdates++)
    check(nav.grab_focus() && window.get_focus() === nav,
        'Parent navigation must accept focus while download continues')
    check(jobs.active?.status === 'running', 'Dismissal cancelled background download')
    reportProgress(0.5)
    await wait(20)
    check(lateUpdates === 0, 'Closed dialog received late progress updates')

    dialog = new VoiceManagerDialog(options)
    dialog.present(window)
    await wait(50)
    check(button(dialog, 'Cancel')?.sensitive, 'Reopen lost Cancel')
    check(dialog._testState.items[0].progress === 0.5, 'Reopen lost progress')
    const [busyMinimum] = dialog.child.measure(Gtk.Orientation.HORIZONTAL, -1)
    check(busyMinimum <= 360, 'Background guidance exceeds narrow window')
    const otherWindow = new Adw.Window({ default_width: 520, default_height: 640 })
    otherWindow.present()
    const otherDialog = new VoiceManagerDialog(options)
    otherDialog.present(otherWindow)
    check(button(otherDialog, 'Cancel')?.sensitive,
        'Another book/window did not observe the same active transfer')
    otherDialog.close()
    await until(() => !otherWindow.get_visible_dialog())
    otherWindow.destroy()
    check(jobs.active?.progress === 0.5,
        'Closing another chooser changed the shared transfer')
    let selections = 0
    dialog.connect('voice-selected', () => selections++)
    finish()
    await pending
    await until(() => dialog._testState.primary === 'Use')
    check(!selections && !dialog._testState.items[0].ready,
        'Background completion automatically selected the voice')
    const [minimum] = dialog.child.measure(Gtk.Orientation.HORIZONTAL, -1)
    check(minimum <= 360, 'Background chooser exceeds narrow window')
    button(dialog, 'Use').emit('clicked')
    await until(() => selections === 1)

    // Failed transfers survive dismissal and remain retryable when reopened.
    dialog.close()
    await until(() => !window.get_visible_dialog())
    const failedJobs = new VoicePackJobs({
        prepareVoicePackChange: async () => () => {},
        download: async () => { throw new Error('network failed') },
    })
    await failedJobs.start(pack)
    dialog = new VoiceManagerDialog({ ...options, jobs: failedJobs })
    dialog.present(window)
    check(dialog._testState.primary === 'Retry Download', 'Reopen lost failure/retry')
    dialog.close()
    await until(() => !window.get_visible_dialog())

    installed = false
    const cancelled = jobs.start(pack)
    await until(() => jobs.active?.progress === 0.25)
    dialog = new VoiceManagerDialog(options)
    dialog.present(window)
    button(dialog, 'Cancel').emit('clicked')
    const result = await cancelled
    check(result.status === 'cancelled' && !jobs.active,
        'Explicit Cancel after reopen did not settle background job')

    // A confirmed repair survives dismissal even before preparation resolves.
    dialog.close()
    await until(() => !window.get_visible_dialog())
    let prepared
    let releases = 0
    const repairs = new VoicePackJobs({
        prepareVoicePackChange: () => new Promise(resolve => { prepared = resolve }),
        repairPack: async () => { installed = true },
    })
    const repairing = repairs.start(pack, 'repair')
    await until(() => !!prepared)
    dialog = new VoiceManagerDialog({ ...options, jobs: repairs })
    dialog.present(window)
    check(button(dialog, 'Cancel')?.sensitive, 'Pending repair lost Cancel')
    dialog.close()
    await until(() => !window.get_visible_dialog())
    check(repairs.active?.kind === 'repair', 'Dismissal cancelled pending repair')
    prepared(() => releases++)
    await repairing
    check(releases === 1, 'Background repair released its lease incorrectly')
    dialog = new VoiceManagerDialog({ ...options, jobs: repairs })
    dialog.present(window)
    check(dialog._testState.primary === 'Use' && !dialog._testState.items[0].ready,
        'Completed background repair skipped explicit Use')
    print('Background chooser dismissal, navigation, reopen, retry and cancel passed')
} finally {
    dialog.close()
    await jobs.shutdown()
    window.destroy()
}
