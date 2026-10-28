import Gtk from 'gi://Gtk?version=4.0'
import Adw from 'gi://Adw?version=1'
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import Soup from 'gi://Soup?version=3.0'

// Every writable root is a fresh, canonical scratch directory. The real
// ~/.local/share/foliate tree is never referenced or linked.
const tmp = GLib.dir_make_tmp('foliate-voice-ui-XXXXXX')
const dataHome = GLib.build_filenamev([tmp, 'data'])
const cacheHome = GLib.build_filenamev([tmp, 'cache'])
const configHome = GLib.build_filenamev([tmp, 'config'])
for (const dir of [dataHome, cacheHome, configHome])
    GLib.mkdir_with_parents(dir, 0o700)
GLib.setenv('XDG_DATA_HOME', dataHome, true)
GLib.setenv('XDG_CACHE_HOME', cacheHome, true)
GLib.setenv('XDG_CONFIG_HOME', configHome, true)
GLib.setenv('GSETTINGS_BACKEND', 'memory', true)
Gtk.init()
Adw.init()

const { VoiceManagerDialog } = await import('../src/voice-manager.js')
const { VoicePackJobs } = await import('../src/voice-pack-jobs.js')
const { verifyPack, deletePack, packDir } = await import('../src/voice-packs.js')

const check = (ok, message) => {
    if (!ok) throw new Error(message)
}
const descendants = function* (widget) {
    yield widget
    for (let child = widget.get_first_child(); child; child = child.get_next_sibling())
        yield* descendants(child)
}
const wait = ms => new Promise(resolve =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
        () => (resolve(), GLib.SOURCE_REMOVE)))
const waitFor = async (predicate, message, timeout = 10000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
        if (predicate()) return
        await wait(10)
    }
    throw new Error(message)
}
const findButton = (widget, label) =>
    [...descendants(widget)].find(w =>
        w instanceof Gtk.Button && w.label === label)
const findIconButton = (widget, iconName) =>
    [...descendants(widget)].find(w =>
        w instanceof Gtk.Button && w.icon_name === iconName)
const visibleChecks = widget =>
    // is_visible() walks the ancestors: a hidden narrator combo's own
    // selected-item check must not count as a row selection
    [...descendants(widget)].filter(w =>
        w instanceof Gtk.Image && w.icon_name === 'object-select-symbolic'
        && w.is_visible()).length

// --- fixture tarball and loopback server ---
GLib.mkdir_with_parents(`${tmp}/fixture`, 0o700)
GLib.file_set_contents(`${tmp}/fixture/model.onnx`, 'fixture')
Gio.Subprocess.new(['tar', '-cjf', `${tmp}/pack.tar.bz2`, '-C', tmp, 'fixture'],
    Gio.SubprocessFlags.NONE).wait_check(null)
const [bytes] = Gio.File.new_for_path(`${tmp}/pack.tar.bz2`).load_bytes(null)
const server = new Soup.Server()
server.add_handler('/voice', (_, message) => {
    message.set_status(200, null)
    message.set_response('application/octet-stream',
        Soup.MemoryUse.COPY, bytes.get_data())
})
server.add_handler('/fail', (_, message) => {
    message.set_status(503, null)
})
server.add_handler('/hang', (_, message) => message.pause())
server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY)
const baseUrl = server.get_uris()[0].to_string()
const pack = {
    id: 'ui-fixture', label: 'Fixture', sizeMB: 1, languages: ['en'],
    sample: 'Hello from the fixture voice.',
    url: baseUrl + 'voice',
    sha256: GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, bytes),
    expectedFiles: ['model.onnx'],
}

const dialogJobs = new WeakMap()
const makeDialog = options => {
    const jobs = options.jobs ?? new VoicePackJobs({
        prepareVoicePackChange: async () => () => {},
        ...options.operations,
    })
    const dialog = new VoiceManagerDialog({ ...options, jobs })
    dialogJobs.set(dialog, jobs)
    return dialog
}

const withDialog = async (options, fn) => {
    const window = new Adw.Window({ default_width: 520, default_height: 640 })
    window.present()
    const dialog = makeDialog(options)
    dialog.present(window)
    await wait(50)
    try {
        return await fn(dialog, window)
    } finally {
        dialog.close()
        await dialogJobs.get(dialog).shutdown()
        await wait(50)
        window.destroy()
    }
}

try {
    // 1. Download installs and highlights but does not auto-select. Use is
    //    explicit and emits the caller-compatible signal. The native probe is
    //    injected: the fixture model is not a real ONNX model and the test
    //    host has no sherpa-onnx engine.
    await withDialog({
        packs: [pack],
        language: 'en',
        operations: {
            ensurePackReady: async () => {},
            prepareVoicePackChange: async () => () => {},
            stopAndWait: async () => {},
        },
    }, async dialog => {
        let selected
        dialog.connect('voice-selected', (_, value) => selected = value)
        check(visibleChecks(dialog.child) === 1, 'exactly one selected row')
        const download = findButton(dialog.child, 'Download')
        check(download, 'download action not discoverable')
        download.emit('clicked')
        await waitFor(() => dialog._testState.primary === 'Use',
            'download did not reach the explicit Use action')
        check(selected === undefined, 'download must not auto-select')
        check(dialog._testState.items[0].state === 'installed',
            'download did not install the pack')
        check(dialog._testState.items[0].candidate,
            'download did not highlight the candidate')
        check(verifyPack(pack), 'downloaded pack does not verify')
        const use = findButton(dialog.child, 'Use')
        check(use, 'use action not discoverable after download')
        use.emit('clicked')
        await waitFor(() => selected !== undefined, 'explicit Use did not emit voice-selected')
        check(selected?.id === 'ui-fixture', 'voice-selected carried the wrong pack')
        check(dialog._testState.items[0].ready, 'Use did not mark the pack ready')
    })

    // 1b. First download acquires the mutation lease and releases it.
    {
        let leaseAcquired = false
        let leaseReleased = false
        const leasePack = { ...pack, id: 'ui-lease', label: 'Lease Fixture' }
        await withDialog({
            packs: [leasePack],
            language: 'en',
            operations: {
                ensurePackReady: async () => {},
                prepareVoicePackChange: async () => {
                    leaseAcquired = true
                    return () => { leaseReleased = true }
                },
                stopAndWait: async () => {},
            },
        }, async dialog => {
            const download = findButton(dialog.child, 'Download')
            check(download, 'lease download action not discoverable')
            download.emit('clicked')
            await waitFor(() => dialog._testState.primary === 'Use',
                'lease download did not reach the explicit Use action')
            check(leaseAcquired, 'download did not acquire the mutation lease')
            check(leaseReleased, 'download did not release the mutation lease')
        })
        deletePack(leasePack.id)
    }

    // 1c. Failed download shows retryable error and preserves error on refresh.
    {
        const failPack = { ...pack, id: 'ui-fail', label: 'Fail Fixture', url: baseUrl + 'fail' }
        await withDialog({
            packs: [failPack],
            language: 'en',
            operations: {
                prepareVoicePackChange: async () => () => {},
                stopAndWait: async () => {},
            },
        }, async dialog => {
            const download = findButton(dialog.child, 'Download')
            check(download, 'fail download action not discoverable')
            download.emit('clicked')
            await waitFor(() => dialog._testState.items[0].state === 'failed',
                'failed download did not enter failed state')
            check(dialog._testState.items[0].error, 'failed download did not set error')
            check(dialog._testState.primary === 'Retry Download',
                'failed download did not offer retry')
        })
        deletePack(failPack.id)
    }

    // 2. Long technical errors do not expand the dialog's minimum width.
    const longMessage = 'engine failure: ' + 'x'.repeat(236)
    const invalidPack = { ...pack, id: 'ui-invalid', label: 'Invalid Fixture' }
    await withDialog({
        packs: [invalidPack],
        language: 'en',
        operations: {
            getPackState: () => ({ status: 'invalid', message: longMessage }),
            repairPack: async () => {},
            prepareVoicePackChange: async () => () => {},
        },
    }, async dialog => {
        const [minWidth] = dialog.child.measure(Gtk.Orientation.HORIZONTAL, -1)
        check(minWidth < 600,
            `long error expanded the minimum width to ${minWidth}`)
        const labels = [...descendants(dialog.child)].filter(w => w instanceof Gtk.Label)
        const errorLabel = labels.find(w => w.wrap && w.max_width_chars <= 80)
        check(errorLabel, 'wrapping bounded error label not found')
        check(dialog._testState.items[0].state === 'invalid',
            'invalid pack state not reflected')
    })

    // 3. A failed removal keeps selection and never emits voice-removed.
    const removePack = { ...pack, id: 'ui-remove', label: 'Remove Fixture' }
    GLib.mkdir_with_parents(packDir(removePack.id), 0o700)
    GLib.file_set_contents(`${packDir(removePack.id)}/model.onnx`, 'keep')
    GLib.setenv('XDG_DATA_HOME', dataHome, true)
    await withDialog({
        packs: [removePack],
        language: 'en',
        operations: {
            getPackState: p => ({ status: verifyPack(p) ? 'installed' : 'missing', message: null }),
            prepareVoicePackChange: async () => () => {},
            stopAndWait: async () => {},
        },
    }, async dialog => {
        let removed = null
        dialog.connect('voice-removed', (_, id) => removed = id)
        check(dialog._testState.selectedId === 'ui-remove', 'selection lost before remove')
        const dir = Gio.File.new_for_path(packDir(removePack.id))
        dir.set_attribute_uint32('unix::mode', 0o500,
            Gio.FileQueryInfoFlags.NONE, null)
        try {
            await dialog._testRemove().catch(() => {})
            check(removed === null, 'voice-removed emitted after failed delete')
            check(dialog._testState.selectedId === 'ui-remove',
                'failed remove lost the selection')
            check(dialog._testState.items[0].state === 'failed',
                'failed remove did not keep a retryable failed state')
            check(dialog._testState.primary === 'Retry Remove',
                'failed remove did not offer retry')
        } finally {
            dir.set_attribute_uint32('unix::mode', 0o700,
                Gio.FileQueryInfoFlags.NONE, null)
        }
    })
    deletePack(removePack.id)

    // 3b. Failed repair preserves selection, emits no success, shows retry,
    //     and releases the mutation lease exactly once.
    {
        let leaseAcquired = 0
        let leaseReleased = 0
        const repairPack = { ...pack, id: 'ui-repair-fail', label: 'Repair Fail' }
        await withDialog({
            packs: [repairPack],
            language: 'en',
            operations: {
                getPackState: () => ({ status: 'invalid', message: 'bad' }),
                repairPack: async () => { throw new Error('repair failed') },
                prepareVoicePackChange: async () => {
                    leaseAcquired += 1
                    return () => { leaseReleased += 1 }
                },
                stopAndWait: async () => {},
            },
        }, async dialog => {
            let selected = null
            let removed = null
            dialog.connect('voice-selected', (_, v) => { selected = v })
            dialog.connect('voice-removed', (_, v) => { removed = v })
            check(dialog._testState.selectedId === 'ui-repair-fail',
                'repair selection lost before start')
            await dialog._testRepair().catch(() => {})
            check(dialog._testState.selectedId === 'ui-repair-fail',
                'failed repair lost selection')
            check(selected === null, 'failed repair emitted voice-selected')
            check(removed === null, 'failed repair emitted voice-removed')
            check(dialog._testState.items[0].state === 'failed',
                'failed repair did not enter failed state')
            check(dialog._testState.items[0].error,
                'failed repair did not set a persistent error')
            check(dialog._testState.primary === 'Retry Repair',
                'failed repair did not offer retry')
            check(leaseAcquired === 1, `repair acquired lease ${leaseAcquired} times`)
            check(leaseReleased === 1, `repair released lease ${leaseReleased} times`)
        })
        deletePack(repairPack.id)
    }

    // 3c. Repair retry success installs but still requires explicit Use/readiness.
    {
        let leaseAcquired = 0
        let leaseReleased = 0
        let repairAttempts = 0
        let repaired = false
        const repairPack = { ...pack, id: 'ui-repair-retry', label: 'Repair Retry' }
        await withDialog({
            packs: [repairPack],
            language: 'en',
            operations: {
                getPackState: () => ({
                    status: repaired ? 'installed' : 'invalid',
                    message: repaired ? null : 'bad',
                }),
                repairPack: async () => {
                    repairAttempts += 1
                    if (repairAttempts === 1) throw new Error('first repair fails')
                    repaired = true
                },
                prepareVoicePackChange: async () => {
                    leaseAcquired += 1
                    return () => { leaseReleased += 1 }
                },
                ensurePackReady: async () => {},
                stopAndWait: async () => {},
            },
        }, async dialog => {
            let selected = null
            dialog.connect('voice-selected', (_, v) => { selected = v })
            await dialog._testRepair().catch(() => {})
            check(dialog._testState.items[0].state === 'failed',
                'first repair did not fail')
            check(dialog._testState.primary === 'Retry Repair',
                'failed repair did not offer retry')
            await dialog._testRepair().catch(() => {})
            check(dialog._testState.items[0].state === 'installed',
                'repair retry did not install the pack')
            check(dialog._testState.items[0].ready === false,
                'repair retry marked the pack ready without explicit Use')
            check(dialog._testState.primary === 'Use',
                'repair retry did not offer explicit Use')
            check(selected === null, 'repair retry auto-selected the pack')
            check(leaseAcquired === 2, `repair acquired lease ${leaseAcquired} times`)
            check(leaseReleased === 2, `repair released lease ${leaseReleased} times`)
            const use = findButton(dialog.child, 'Use')
            check(use, 'explicit Use not discoverable after repair retry')
            use.emit('clicked')
            await waitFor(() => selected !== null,
                'explicit Use after repair retry did not emit voice-selected')
            check(selected?.id === 'ui-repair-retry',
                'voice-selected carried the wrong repaired pack')
            check(dialog._testState.items[0].ready,
                'explicit Use after repair retry did not mark the pack ready')
        })
        deletePack(repairPack.id)
    }

    // 3d. Closing during a pending repair releases the lease and suppresses
    //     late success.
    {
        let leaseAcquired = 0
        let leaseReleased = 0
        let repairResolve = null
        const repairPack = { ...pack, id: 'ui-repair-close', label: 'Repair Close' }
        const window = new Adw.Window({ default_width: 520, default_height: 640 })
        window.present()
        const dialog = makeDialog({
            packs: [repairPack],
            language: 'en',
            operations: {
                getPackState: () => ({ status: 'invalid', message: 'bad' }),
                repairPack: () => new Promise(resolve => { repairResolve = resolve }),
                prepareVoicePackChange: async () => {
                    leaseAcquired += 1
                    return () => { leaseReleased += 1 }
                },
                stopAndWait: async () => {},
            },
        })
        dialog.present(window)
        await wait(50)
        let selected = null
        let removed = null
        dialog.connect('voice-selected', (_, v) => { selected = v })
        dialog.connect('voice-removed', (_, v) => { removed = v })
        const repairPromise = dialog._testRepair().catch(() => {})
        await waitFor(() => dialog._testState.operation === 'repair',
            'repair did not start')
        await waitFor(() => leaseAcquired === 1,
            'repair did not acquire the lease')
        dialog.close()
        await wait(50)
        repairResolve?.()
        await repairPromise
        await wait(50)
        check(leaseAcquired === 1, `close repair acquired lease ${leaseAcquired} times`)
        check(leaseReleased === 1, `close repair released lease ${leaseReleased} times`)
        check(selected === null, 'close repair emitted voice-selected')
        check(removed === null, 'close repair emitted voice-removed')
        window.destroy()
        deletePack(repairPack.id)
    }

    // 4. Preview Stop is available and stops the owned preview.
    let previewResolve = null
    const previewPlayer = {
        play: () => new Promise(resolve => { previewResolve = resolve }),
        stop: () => {},
    }
    await withDialog({
        packs: [pack],
        language: 'en',
        player: previewPlayer,
        operations: {
            getPackState: p => ({ status: verifyPack(p) ? 'installed' : 'missing', message: null }),
            stopAndWait: async () => { previewResolve?.() },
            prepareVoicePackChange: async () => () => {},
        },
    }, async dialog => {
        const preview = findIconButton(dialog.child, 'media-playback-start-symbolic')
        check(preview, 'preview control not discoverable')
        preview.emit('clicked')
        await waitFor(() => dialog._testState.previewing === true,
            'preview did not enter the previewing state')
        const stop = findIconButton(dialog.child, 'media-playback-stop-symbolic')
        check(stop, 'stop control not discoverable during preview')
        stop.emit('clicked')
        await waitFor(() => dialog._testState.previewing === false,
            'preview did not stop')
    })

    // 5. Closing leaves shared transfer running; explicit cancellation settles it.
    const hangPack = { ...pack, id: 'ui-hang', label: 'Hang Fixture', url: baseUrl + 'hang' }
    {
        const window = new Adw.Window({ default_width: 520, default_height: 640 })
        window.present()
        const dialog = makeDialog({ packs: [hangPack], language: 'en' })
        dialog.present(window)
        await wait(50)
        const download = findButton(dialog.child, 'Download')
        check(download, 'hang download action not discoverable')
        download.emit('clicked')
        await waitFor(() => dialog._testState.operation === 'download',
            'hang download did not start')
        dialog.close()
        await wait(300)
        check(dialog._testState.operation === 'download',
            'close cancelled the background download')
        await dialogJobs.get(dialog).shutdown()
        check(dialog._testState.operation === null,
            'explicit shutdown did not settle the pending download')
        window.destroy()
    }

    // 5b. The overflow popover's Remove acts on the selected voice and cannot
    //     strand the dialog in a stuck busy operation.
    await withDialog({
        packs: [pack],
        language: 'en',
        operations: {
            getPackState: () => ({ status: 'installed', message: null }),
            prepareVoicePackChange: async () => () => {},
            stopAndWait: async () => {},
        },
    }, async dialog => {
        const menu = [...descendants(dialog.child)]
            .find(w => w instanceof Gtk.MenuButton
                && w.icon_name === 'view-more-symbolic')
        check(menu, 'overflow menu not discoverable')
        const remove = [...descendants(menu.popover)]
            .find(w => w instanceof Gtk.Button && w.label === 'Remove Voice')
        check(remove, 'overflow Remove not discoverable')
        remove.emit('clicked')
        await wait(30)
        check(dialog._testState.operation === null,
            'popover Remove left the dialog stuck in a busy operation')
    })

    // 5c. Stop stays sensitive while previewing, and a failing preview keeps
    //     its retryable failed state instead of resetting to installed.
    const failPlayer = {
        play: () => new Promise((resolve, reject) =>
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
                reject(new Error('preview engine failed'))
                return GLib.SOURCE_REMOVE
            })),
    }
    await withDialog({
        packs: [pack],
        language: 'en',
        player: failPlayer,
        operations: {
            getPackState: () => ({ status: 'installed', message: null }),
            stopAndWait: async () => {},
        },
    }, async dialog => {
        const preview = findIconButton(dialog.child,
            'media-playback-start-symbolic')
        check(preview, 'preview control missing for the failure test')
        preview.emit('clicked')
        await waitFor(() => dialog._testState.previewing === true,
            'failing preview did not start')
        await waitFor(() => {
            const stop = findIconButton(dialog.child,
                'media-playback-stop-symbolic')
            return stop && stop.sensitive
        }, 'Stop became insensitive during preview')
        await waitFor(() => dialog._testState.items[0].state === 'failed',
            'preview failure did not reach failed state')
        check(dialog._testState.primary === 'Retry',
            'preview failure lost its retryable primary action')
        check(dialog._testState.items[0].error,
            'preview failure did not set a persistent error')
    })

    // 5d. A Use failure with a completed invalid-model verdict exposes
    //     Repair instead of looping on Retry.
    await withDialog({
        packs: [pack],
        language: 'en',
        operations: {
            getPackState: () => ({ status: 'installed', message: null }),
            ensurePackReady: async () => {
                const error = new Error('probe verdict: broken model')
                error.code = 'invalid-pack'
                throw error
            },
            prepareVoicePackChange: async () => () => {},
        },
    }, async dialog => {
        const use = findButton(dialog.child, 'Use')
        use.emit('clicked')
        await waitFor(() => dialog._testState.items[0].state === 'failed',
            'failed Use did not reach failed state')
        check(dialog._testState.primary === 'Repair',
            'invalid-model Use failure did not expose Repair')
    })

    // 5e. Closing frees the mutation gate only after pending work settles.
    {
        let leaseAcquired = 0
        let leaseReleased = 0
        let settle = null
        const closePack = { ...pack, id: 'ui-close-hold', label: 'Close Hold' }
        const window = new Adw.Window({ default_width: 520, default_height: 640 })
        window.present()
        const dialog = makeDialog({
            packs: [closePack],
            language: 'en',
            operations: {
                getPackState: () => ({ status: 'invalid', message: 'bad' }),
                repairPack: () => new Promise(resolve => { settle = resolve }),
                prepareVoicePackChange: async () => {
                    leaseAcquired += 1
                    return () => { leaseReleased += 1 }
                },
                stopAndWait: async () => {},
            },
        })
        dialog.present(window)
        await wait(50)
        const pending = dialog._testRepair().catch(() => {})
        await waitFor(() => dialog._testState.operation === 'repair',
            'close-ready repair did not start')
        await waitFor(() => leaseAcquired === 1,
            'close-ready repair did not acquire the lease')
        dialog.close()
        await wait(30)
        check(leaseReleased === 0,
            `close released the mutation gate while work was pending (${leaseReleased})`)
        settle?.()
        await pending
        await wait(30)
        check(leaseReleased === 1,
            'pending repair settled without releasing the gate')
        window.destroy()
        deletePack(closePack.id)
    }

    // 6. Three packs expose one selection and one recommended marker, not
    //    three suggested actions.
    const threePacks = [
        { ...pack, id: 'ui-a', label: 'A', languages: ['en'] },
        { ...pack, id: 'ui-b', label: 'B', languages: ['en'], default: true },
        { ...pack, id: 'ui-c', label: 'C', languages: ['fr'] },
    ]
    await withDialog({ packs: threePacks, language: 'en' }, async dialog => {
        check(visibleChecks(dialog.child) === 1,
            'three packs must expose exactly one selected row')
        const labels = [...descendants(dialog.child)].filter(w => w instanceof Gtk.Label)
        check(labels.filter(w => w.label === 'Recommended' && w.visible).length === 1,
            'three packs must expose exactly one recommended marker')
    })

    // 7. Narrator group: ten choices, Supertonic only, driven by the
    //    book-level SID state the viewer passes in.
    const narratorPack = id => ({
        ...pack, id, label: 'Supertonic 3', default: true, sid: 0,
        sample: 'Hello from the Supertonic fixture voice.',
    })
    const narratorOperations = {
        getPackState: () => ({ status: 'installed', message: null }),
        ensurePackReady: async () => {},
        prepareVoicePackChange: async () => () => {},
        stopAndWait: async () => {},
    }
    const findCombo = widget =>
        [...descendants(widget)].find(w => w instanceof Adw.ComboRow)
    const findReset = widget => {
        const menu = [...descendants(widget)].find(w =>
            w instanceof Gtk.MenuButton && w.icon_name === 'view-more-symbolic')
        return menu?.popover && [...descendants(menu.popover)]
            .find(w => w instanceof Gtk.Button
                && w.label === 'Reset to Default Narrator')
    }

    // 7a. Supertonic shows a ten-choice Narrator group on the effective SID.
    await withDialog({
        packs: [narratorPack('supertonic')],
        language: 'en', effectiveSid: 5, storedSid: 5, getGlobalSid: () => 0,
        operations: narratorOperations,
    }, async dialog => {
        const s = dialog._testState
        check(s.narratorVisible, 'Supertonic did not show the narrator group')
        check(s.narratorChoices === 10,
            `narrator group must hold ten choices, got ${s.narratorChoices}`)
        check(s.narratorSelected === 5,
            `narrator must start on the effective SID, got ${s.narratorSelected}`)
        const reset = findReset(dialog.child)
        check(reset && reset.visible, 'reset must appear in More Actions for Supertonic')
    })

    // 7b. Non-Supertonic engines do not show the narrator group.
    await withDialog({
        packs: [narratorPack('kokoro'), narratorPack('piper')],
        language: 'en', effectiveSid: 3, storedSid: 3, getGlobalSid: () => 3,
        operations: narratorOperations,
    }, async dialog => {
        const s = dialog._testState
        check(!s.narratorVisible, 'non-Supertonic must not show the narrator group')
        const reset = findReset(dialog.child)
        check(!reset || !reset.visible,
            'reset must not appear in More Actions for non-Supertonic')
    })

    // 7c. Changing the combo and pressing Preview passes the SID to the
    //     player and emits no narrator signal.
    {
        let recorded = null
        await withDialog({
            packs: [narratorPack('supertonic')],
            language: 'en', effectiveSid: 0, storedSid: null, getGlobalSid: () => 0,
            operations: narratorOperations,
            player: {
                play: (_sentences, options) => {
                    recorded = options
                    return Promise.resolve()
                },
                stop: () => {},
            },
        }, async dialog => {
            const signals = []
            dialog.connect('narrator-selected',
                (_, sid) => signals.push(['narrator-selected', sid]))
            const combo = findCombo(dialog.child)
            check(combo, 'narrator combo not discoverable')
            combo.selected = 7
            const preview = findIconButton(dialog.child, 'media-playback-start-symbolic')
            check(preview, 'preview control missing')
            await dialog._testPreview()
            check(recorded?.voice === 7,
                `preview did not pass the combo SID to the player (got ${recorded?.voice})`)
            check(signals.length === 0,
                'Preview must not emit narrator-selected')
        })
    }

    // 7c2. Preview keeps non-Supertonic packs on their fixed pack SID.
    {
        let recorded = null
        await withDialog({
            packs: [narratorPack('kokoro')],
            language: 'en', effectiveSid: 7, storedSid: 7, getGlobalSid: () => 0,
            operations: narratorOperations,
            player: {
                play: (_sentences, options) => {
                    recorded = options
                    return Promise.resolve()
                },
                stop: () => {},
            },
        }, async dialog => {
            await dialog._testPreview()
            check(recorded && !Object.hasOwn(recorded, 'voice'),
                'non-Supertonic Preview must not pass a narrator SID')
        })
    }

    // 7d. Use after a real combo change emits narrator-selected BEFORE
    //     voice-selected, and a pack handler sees the new SID already.
    //     Using without changing the narrator emits no narrator-selected.
    {
        let applied = null
        let seenByPackHandler = null
        await withDialog({
            packs: [narratorPack('supertonic')],
            language: 'en', effectiveSid: 2, storedSid: 2, getGlobalSid: () => 0,
            operations: narratorOperations,
        }, async dialog => {
            const events = []
            dialog.connect('narrator-selected', (_, sid) => {
                applied = sid
                events.push(['narrator-selected', sid])
            })
            dialog.connect('voice-selected', (_, pack) => {
                seenByPackHandler = applied
                events.push(['voice-selected', pack.id])
            })
            const combo = findCombo(dialog.child)
            combo.selected = 7
            const use = findButton(dialog.child, 'Use')
            use.emit('clicked')
            await waitFor(() => events.length === 2,
                'explicit Use after a combo change did not emit both signals')
            check(events[0][0] === 'narrator-selected' && events[0][1] === 7,
                `narrator-selected must come first with SID 7, got ${events[0]}`)
            check(events[1][0] === 'voice-selected',
                'voice-selected must come after narrator-selected')
            check(seenByPackHandler === 7,
                'pack handler did not already see the new SID')
            // a second Use without touching the combo must not re-apply
            const matchedNarrator = applied
            let secondNarrator = null
            dialog.connect('narrator-selected', (_, sid) => secondNarrator = sid)
            use.emit('clicked')
            await waitFor(() => dialog._testState.operation === null,
                'second Use did not settle')
            check(secondNarrator === null,
                'unchanged Use must not re-emit narrator-selected')
            check(applied === matchedNarrator, 'applied SID changed unexpectedly')
        })
    }

    // 7e. Using without changing the narrator makes no book choice.
    await withDialog({
        packs: [narratorPack('supertonic')],
        language: 'en', effectiveSid: 4, storedSid: null, getGlobalSid: () => 0,
        operations: narratorOperations,
    }, async dialog => {
        let narrator = null
        dialog.connect('narrator-selected', (_, sid) => narrator = sid)
        const use = findButton(dialog.child, 'Use')
        use.emit('clicked')
        await waitFor(() => dialog._testState.primary === 'Use'
            && dialog._testState.operation === null,
        'unchanged Use did not settle')
        check(narrator === null,
            'Use without a narrator change must not emit narrator-selected')
    })

    // 7e2. Returning to the effective narrator is a net-zero change.
    await withDialog({
        packs: [narratorPack('supertonic')],
        language: 'en', effectiveSid: 4, storedSid: null, getGlobalSid: () => 0,
        operations: narratorOperations,
    }, async dialog => {
        let narrator = null
        dialog.connect('narrator-selected', (_, sid) => narrator = sid)
        const combo = findCombo(dialog.child)
        combo.selected = 7
        combo.selected = 4
        const use = findButton(dialog.child, 'Use')
        use.emit('clicked')
        await waitFor(() => dialog._testState.operation === null,
            'net-zero Use did not settle')
        check(narrator === null,
            'returning to the effective narrator must not create a book choice')
    })

    // 7f. Reset is sensitive exactly when the book stores a non-null SID,
    //     even when that SID equals the global. Reset reads the global at
    //     click time, clears the stored SID (so it is insensitive and a
    //     no-op afterwards), and clears pending changes.
    {
        let globalSid = 3
        await withDialog({
            packs: [narratorPack('supertonic')],
            language: 'en', effectiveSid: 7, storedSid: 7,
            getGlobalSid: () => globalSid,
            operations: narratorOperations,
        }, async dialog => {
            const reset = findReset(dialog.child)
            check(reset?.sensitive,
                'reset must be sensitive with a stored non-null SID')
            const combo = findCombo(dialog.child)
            check(combo.selected === 7, 'combo should start on stored SID 7')
            combo.selected = 0
            // a global change while the dialog is open is honored: the
            // global is read at reset time, not constructor time
            globalSid = 5
            const events = []
            dialog.connect('narrator-reset', () => events.push('reset'))
            reset.emit('clicked')
            check(events.length === 1, 'reset must emit narrator-reset')
            check(combo.selected === 5,
                `reset must move the combo to getGlobalSid() at click time, got ${combo.selected}`)
            check(reset.sensitive === false,
                'reset must lose sensitivity once the book no longer stores a SID')
            reset.emit('clicked')
            check(events.length === 1,
                'a second reset without a stored SID must not re-emit narrator-reset')
            // pending is cleared: use directly after reset with no new
            // combo change — no book choice may be written
            let narratorSelected = null
            dialog.connect('narrator-selected', (_, sid) => narratorSelected = sid)
            const use = findButton(dialog.child, 'Use')
            use.emit('clicked')
            await waitFor(() => dialog._testState.operation === null,
                'Use after reset did not settle')
            check(narratorSelected === null,
                'Use after reset must not emit narrator-selected')
        })
    }

    // 7g. Reset is insensitive when the book follows default (stored null),
    //     even though the global selector is available.
    await withDialog({
        packs: [narratorPack('supertonic')],
        language: 'en', effectiveSid: 0, storedSid: null, getGlobalSid: () => 0,
        operations: narratorOperations,
    }, async dialog => {
        const reset = findReset(dialog.child)
        check(reset && !reset.sensitive,
            'reset must be insensitive with no stored book SID')
    })

    // 7h. refreshNarrator moves the combo without emitting; it keeps a
    //     pending user change.
    {
        let signals = 0
        await withDialog({
            packs: [narratorPack('supertonic')],
            language: 'en', effectiveSid: 0, storedSid: null, getGlobalSid: () => 0,
            operations: narratorOperations,
        }, async dialog => {
            dialog.connect('narrator-selected', () => signals += 1)
            dialog.connect('narrator-reset', () => signals += 1)
            dialog.refreshNarrator(6, 3)
            const combo = findCombo(dialog.child)
            check(combo.selected === 6,
                'refresh with no pending change must move the combo')
            check(signals === 0, 'refresh must not emit signals')
            combo.selected = 7
            dialog.refreshNarrator(6, 3)
            check(combo.selected === 7,
                'refresh must not overwrite a pending user change')
            // an absent stored SID normalizes to null: reset is insensitive
            dialog.refreshNarrator(6, undefined)
            const reset = findReset(dialog.child)
            check(reset && reset.sensitive === false,
                'refresh with undefined stored SID must leave reset insensitive')
        })
    }

    // 7i. No user-visible string may say "override" or "inherited".
    await withDialog({
        packs: [narratorPack('supertonic')],
        language: 'en', effectiveSid: 0, storedSid: null, getGlobalSid: () => 0,
        operations: narratorOperations,
    }, async dialog => {
        const strings = [...descendants(dialog.child)]
            .filter(w => w instanceof Gtk.Label || w instanceof Gtk.Button
                || w instanceof Adw.ActionRow || w instanceof Adw.PreferencesGroup
                || w instanceof Adw.ComboRow)
            .flatMap(w => [w.label, w.title, w.subtitle, w.tooltip_text])
        const menu = [...descendants(dialog.child)]
            .find(w => w instanceof Gtk.MenuButton && w.icon_name === 'view-more-symbolic')
        if (menu?.popover) strings.push(
            ...[...descendants(menu.popover)]
                .filter(w => w instanceof Gtk.Button)
                .flatMap(w => [w.label, w.tooltip_text]))
        for (const text of strings)
            if (typeof text === 'string')
                check(!/override|inherited/i.test(text),
                    `user-visible string must not say override/inherited: ${text}`)
    })

    print('Voice manager compact-chooser tests passed')
} finally {
    server.disconnect()
    deletePack(pack.id)
    deletePack('ui-invalid')
    deletePack('ui-hang')
    // The scratch XDG roots are fresh and live under TMPDIR. Leave them for
    // the system temp reaper: deleting a live GJS cache tree races its own
    // cache writers and is not part of the chooser contract.
    print(`scratch XDG roots: ${tmp}`)
}
