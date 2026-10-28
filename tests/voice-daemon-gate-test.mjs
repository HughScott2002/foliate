import { exit } from 'system'
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'

// The gate needs no daemon binary: preparation settles this app's daemon
// (none is running) and read leases stand in for CLI/probe readers.
const tmp = GLib.dir_make_tmp('foliate-gate-XXXXXX')
GLib.setenv('XDG_DATA_HOME', tmp, true)
GLib.setenv('XDG_CACHE_HOME', tmp, true)
GLib.setenv('XDG_CONFIG_HOME', tmp, true)

const gate = await import('../src/voice-daemon-gate.js')
const daemon = await import('../src/voice-daemon.js')

let failures = 0
const assert = (cond, msg) => {
    if (cond) return
    failures++
    printerr(`FAIL: ${msg}`)
}
const tick = ms => new Promise(resolve =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms,
        () => (resolve(), GLib.SOURCE_REMOVE)))
const rejection = async (promise, label) => {
    try {
        await promise
    } catch (error) {
        return error
    }
    failures++
    printerr(`FAIL: ${label} should have rejected`)
    return null
}
const stop = async () => true

// --- a successful preparation closes the gate and releases it ---

{
    const release = await daemon.prepareVoicePackChange({ stopDaemon: stop })
    assert(gate.isMutationInProgress(),
        'the gate stays closed across publication and rollback')
    const leaseError = await rejection(
        Promise.resolve().then(() => gate.acquireReadLease()),
        'new reader while gate closed')
    assert(leaseError?.code === 'mutation-in-progress',
        `new readers are blocked (got: ${leaseError?.code})`)
    const startError = await rejection(
        daemon.getVoiceDaemon().start(), 'daemon startup while gate closed')
    assert(startError?.code === 'mutation-in-progress',
        `lazy daemon startup is blocked (got: ${startError?.code})`)
    release()
    assert(!gate.isMutationInProgress(), 'release reopens the gate')
    const lease = gate.acquireReadLease()
    lease()
}

// --- the gate is exclusive: a second change is refused ---

{
    const release = await daemon.prepareVoicePackChange({ stopDaemon: stop })
    const error = await rejection(
        daemon.prepareVoicePackChange({ stopDaemon: stop }),
        'nested mutation')
    assert(error?.code === 'mutation-in-progress',
        `a nested change is refused (got: ${error?.code})`)
    release()
    assert(!gate.isMutationInProgress(), 'the refused change did not stay closed')
}

// --- a daemon that refuses to stop releases its own gate ---

{
    const error = await rejection(
        daemon.prepareVoicePackChange({ stopDaemon: async () => false }),
        'refused daemon stop')
    assert(/did not stop/.test(error?.message ?? ''),
        `a refused stop is reported (got: ${error?.message})`)
    assert(!gate.isMutationInProgress(),
        'a failed preparation releases its own gate')
}

// --- a thrown settlement releases its own gate ---

{
    const error = await rejection(
        daemon.prepareVoicePackChange({
            stopDaemon: async () => { throw new Error('settle boom') },
        }), 'thrown settlement')
    assert(/settle boom/.test(error?.message ?? ''),
        `the settlement failure propagates (got: ${error?.message})`)
    assert(!gate.isMutationInProgress(),
        'a thrown settlement releases its own gate')
}

// --- an active reader prevents mutation until it settles ---

{
    const lease = gate.acquireReadLease()
    let resolved = false
    const pending = daemon.prepareVoicePackChange({
        stopDaemon: stop, settleTimeoutMs: 200,
    }).then(release => {
        resolved = true
        return release
    })
    await tick(40)
    assert(!resolved, 'mutation waits for an active reader')
    lease()
    const release = await pending
    assert(resolved, 'mutation proceeds once the reader settles')
    release()
}

// --- a wedged reader refuses mutation instead of hanging ---

{
    const lease = gate.acquireReadLease()
    const error = await rejection(
        daemon.prepareVoicePackChange({ stopDaemon: stop, settleTimeoutMs: 40 }),
        'wedged reader')
    assert(error?.code === 'settle-timeout',
        `a wedged reader times out (got: ${error?.code})`)
    assert(!gate.isMutationInProgress(),
        'the timed-out change releases its own gate')
    lease()
    const next = gate.acquireReadLease()
    next()
}

// --- the next synthesis reconciles a fresh catalog ---

{
    daemon.clearDaemonReconcile()
    const release = await daemon.prepareVoicePackChange({ stopDaemon: stop })
    assert(daemon.daemonNeedsReconcile(),
        'a completed change requests a fresh daemon catalog')
    release()
    daemon.clearDaemonReconcile()
    assert(!daemon.daemonNeedsReconcile(),
        'the reconciliation request is consumed once')
}

if (failures) {
    printerr(`${failures} test${failures > 1 ? 's' : ''} failed`)
    exit(1)
}
print('All tests passed')
