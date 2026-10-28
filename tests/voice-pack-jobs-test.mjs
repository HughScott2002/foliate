import { exit } from 'system'
import GLib from 'gi://GLib'

// Focused unit test for the app-process voice pack transfer owner. All
// operations are injected fixtures: no network, no daemon, no disk, no
// GTK widgets. The manager must hold one exclusive mutation lease across
// each entire download/repair (including rollback) and release it exactly
// once in a finally block after settlement.

const { VoicePackJobs, getVoicePackJobs, shutdownVoicePackJobs }
    = await import('../src/voice-pack-jobs.js')

// Always isolate native preparation, not only the transfer operation.
class TestJobs extends VoicePackJobs {
    constructor(operations = {}) {
        super({ prepareVoicePackChange: async () => () => {}, ...operations })
    }
}

let failures = 0
const assert = (cond, msg) => {
    if (cond) return
    failures++
    printerr(`FAIL: ${msg}`)
}
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
// Yields to the GLib main loop so asynchronous fixtures progress.
const flush = () => new Promise(resolve =>
    GLib.idle_add(GLib.PRIORITY_DEFAULT,
        () => (resolve(), GLib.SOURCE_REMOVE)))
const deferred = () => {
    let resolve, reject
    const promise = new Promise((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

const pack = { id: 'p1', label: 'Pack One' }
const packB = { id: 'p2', label: 'Pack Two' }

// --- start resolves the terminal snapshot with exactly the agreed keys ---

{
    const download = async (p, onProgress, cancellable, control) => {
        onProgress?.(0.25)
        onProgress?.(0.75)
    }
    const jobs = new TestJobs({ download })
    assert(jobs.get('p1') === null, 'get() returns null for unknown id')
    assert(jobs.active === null, 'active is null with no job running')
    const snapshot = await jobs.start(pack)
    assert(snapshot.packId === 'p1', 'snapshot carries the pack id')
    assert(snapshot.kind === 'download', 'snapshot carries the kind')
    assert(snapshot.status === 'installed',
        'a completed transfer reports installed')
    assert(snapshot.progress === null, 'terminal snapshot has no progress')
    assert(snapshot.error === null, 'terminal snapshot has no error')
    assert(Object.keys(snapshot).length === 5,
        'snapshot exposes exactly packId/kind/status/progress/error')
    // Shared state is independent of subscribers: get() works with none.
    const stored = jobs.get('p1')
    assert(stored.status === 'installed'
        && stored.kind === 'download' && stored.packId === 'p1'
        && stored.progress === null && stored.error === null,
        'terminal state is readable after settle without subscribers')
    assert(jobs.active === null, 'completed job is no longer active')
    // Snapshots must be detached copies: mutating them cannot corrupt state.
    snapshot.progress = 0.99
    snapshot.status = 'failed'
    assert(jobs.get('p1').status === 'installed'
        && jobs.get('p1').progress === null,
        'mutating a handed-out snapshot does not corrupt manager state')
}

// --- subscriptions receive changes and unsubscribe stops them ---

{
    const gate = deferred()
    const jobs = new TestJobs({
        download: async (p, onProgress, cancellable) => {
            onProgress(0.5)
            await gate.promise
            if (cancellable.is_cancelled()) throw new Error('cancelled')
        },
    })
    const events = []
    const unsubscribe = jobs.subscribe(snapshot =>
        events.push(`${snapshot.status}:${snapshot.progress ?? ''}`))
    const promise = jobs.start(pack)
    await flush()
    await flush()
    assert(jobs.active?.status === 'running',
        'active exposes the running snapshot mid-transfer')
    assert(jobs.active?.progress === 0.5,
        'active exposes reported progress')
    assert(events.at(0) === 'running:',
        'subscribers observe the transition to running')
    assert(events.at(1) === 'running:0.5',
        'subscribers observe progress changes')
    unsubscribe()
    gate.resolve()
    await promise
    assert(events.length === 2,
        'unsubscribe stops delivery before later changes')
    assert(jobs.active === null, 'settled job leaves active null')
}

// --- a throwing subscriber cannot corrupt updates or later emissions ---

{
    const gate = deferred()
    const jobs = new TestJobs({
        download: async (p, onProgress) => {
            onProgress(0.5)
            await gate.promise
        },
    })
    const seen = []
    const bad = jobs.subscribe(snapshot => {
        seen.push(snapshot.status)
        throw new Error('subscriber boom')
    })
    const good = jobs.subscribe(snapshot =>
        seen.push(`good:${snapshot.status}`))
    const promise = jobs.start(pack)
    await flush()
    assert(jobs.get('p1').status === 'running'
        && jobs.get('p1').progress === 0.5,
        'subscriber exception left snapshot state intact')
    gate.resolve()
    await promise
    assert(seen.includes('good:installed'),
        'later emissions still reach other subscribers after a throw')
    bad()
    good()
    assert(jobs.get('p1').status === 'installed',
        'state still correct after exception and unsubscribe')
}

// --- duplicate same-job start shares one promise; conflicts reject ---

{
    const gate = deferred()
    const jobs = new TestJobs({
        download: async () => {
            await gate.promise
        },
    })
    const promise = jobs.start(pack)
    await flush()
    const duplicate = jobs.start(pack)
    assert(promise === duplicate,
        'duplicate start of the same job returns the same promise')
    const otherPackError = await rejection(jobs.start(packB),
        'conflicting start for another pack')
    assert(otherPackError instanceof Error,
        'conflicting start rejects with an error')
    const samePackOtherKind = await rejection(jobs.start(pack, 'repair'),
        'conflicting start with another kind on the same pack')
    assert(samePackOtherKind instanceof Error,
        'a different kind on the same pack also conflicts')
    assert(jobs.active?.packId === 'p1',
        'a conflicting start did not disrupt the existing job')
    gate.resolve()
    const snapshot = await promise
    assert(snapshot.status === 'installed',
        'the shared job still settles normally after refusals')
}

// --- failures are retained until an explicit retry replaces them ---

{
    let fail = true
    const jobs = new TestJobs({
        download: async () => {
            if (fail) throw new Error('network broke')
        },
    })
    const snapshot = await jobs.start(pack)
    assert(snapshot.status === 'failed', 'failing transfer reports failed')
    assert(snapshot.error instanceof Error
        && snapshot.error.message === 'network broke',
        'the failure carries the retained error')
    assert(jobs.get('p1')?.status === 'failed'
        && jobs.get('p1')?.error?.message === 'network broke',
        'failure state is retained after settle')
    assert(jobs.active === null, 'a failed job is not running')
    fail = false
    const retry = await jobs.start(pack)
    assert(retry.status === 'installed', 'retry succeeds after failure')
    assert(jobs.get('p1')?.status === 'installed'
        && jobs.get('p1')?.error === null,
        'retry replaces the retained failure and clears the error')
}

// --- explicit cancel stops only the matching active transfer ---

{
    const jobs = new TestJobs({
        download: async (p, onProgress, cancellable) => {
            while (!cancellable.is_cancelled()) await flush()
            throw new Error('cancelled transfer')
        },
    })
    const promise = jobs.start(pack)
    await flush()
    jobs.cancel('p2')
    await flush()
    assert(jobs.active?.status === 'running',
        'cancel with a non-matching id is ignored')
    jobs.cancel(pack.id)
    const snapshot = await promise
    assert(snapshot.status === 'cancelled',
        'explicit cancel settles the matching job as cancelled')
    assert(snapshot.error === null, 'a cancelled job retains no error')
    assert(jobs.active === null, 'cancelled job is not running')
    jobs.cancel(pack.id) // idempotent on settled jobs
    jobs.cancel('p1')
    assert(jobs.get('p1')?.status === 'cancelled',
        'cancel after settle cannot resurrect or change retained state')
}

// --- cancel while the mutation lease preparation is still pending ---

{
    let downloadCalled = false
    let releaseCalls = 0
    const prepareDeferred = deferred()
    const jobs = new TestJobs({
        prepareVoicePackChange: async () => {
            await prepareDeferred.promise
            return () => { releaseCalls++ }
        },
        download: async () => { downloadCalled = true },
    })
    const promise = jobs.start(pack)
    await flush()
    assert(jobs.active?.status === 'running'
        && jobs.active?.progress === null,
        'the job is running while preparation is still pending')
    jobs.cancel(pack.id)
    prepareDeferred.resolve()
    const snapshot = await promise
    assert(snapshot.status === 'cancelled',
        'a cancel during pending preparation settles cancelled')
    assert(!downloadCalled,
        'the native transfer never starts when cancelled before it began')
    assert(releaseCalls === 1,
        'the late-acquired lease is released exactly once')
    assert(jobs.active === null, 'no work remains after the cancellation')
}

// --- the lease is held across the entire transfer and released once ---

{
    let releaseCalls = 0
    const hold = deferred()
    const jobs = new TestJobs({
        prepareVoicePackChange: async () => () => { releaseCalls++ },
        download: async () => {
            assert(releaseCalls === 0,
                'the mutation lease is still held during the transfer')
            await hold.promise
        },
    })
    const promise = jobs.start(pack)
    await flush()
    assert(releaseCalls === 0, 'the lease is held until settlement')
    hold.resolve()
    const snapshot = await promise
    assert(releaseCalls === 1, 'the lease was released exactly once')
    assert(snapshot.status === 'installed', 'the transfer completed')
}

// --- the lease also releases exactly once after failure/rollback ---

{
    let releaseCalls = 0
    const jobs = new TestJobs({
        prepareVoicePackChange: async () => () => { releaseCalls++ },
        download: async () => {
            throw new Error('checksum mismatch; rolled back')
        },
    })
    const snapshot = await jobs.start(pack)
    assert(snapshot.status === 'failed', 'the failed transfer reports failed')
    assert(snapshot.error?.message === 'checksum mismatch; rolled back',
        'the retained error carries the rollback details')
    assert(releaseCalls === 1,
        'the lease is released exactly once after failure')
    assert(jobs.active === null, 'the failed job is not running')
}

// --- repairs use the repair operation and report the repair kind ---

{
    let downloadCalls = 0
    let repairCalls = 0
    let onProgressSeen = false
    const hold = deferred()
    const jobs = new TestJobs({
        repairPack: async (p, onProgress) => {
            repairCalls++
            onProgress?.(0.5)
            onProgressSeen = true
            await hold.promise
        },
        download: async () => { downloadCalls++ },
    })
    const promise = jobs.start(pack, 'repair')
    await flush()
    assert(jobs.active?.kind === 'repair', 'running snapshot marks repair')
    assert(jobs.active?.progress === 0.5, 'repair progress is reported')
    assert(onProgressSeen, 'the repair fixture ran')
    hold.resolve()
    const snapshot = await promise
    assert(snapshot.kind === 'repair' && snapshot.status === 'installed',
        'the repair job settles installed')
    assert(repairCalls === 1 && downloadCalls === 0,
        'repair kind routes to repairPack, not download')
}

// --- shutdown cancels, awaits cleanup, and prevents new jobs ---

{
    let releaseCalls = 0
    let settledCancelled = null
    const jobs = new TestJobs({
        prepareVoicePackChange: async () => () => { releaseCalls++ },
        download: async (p, onProgress, cancellable) => {
            while (!cancellable.is_cancelled()) await flush()
            throw new Error('cancelled by shutdown')
        },
    })
    const promise = jobs.start(pack)
    await flush()
    const shutdownPromise = jobs.shutdown()
    await shutdownPromise
    assert(releaseCalls === 1,
        'shutdown awaited the lease release of the cancelled job')
    settledCancelled = await promise
    assert(settledCancelled.status === 'cancelled',
        'shutdown cancels the owned transfer')
    assert(jobs.active === null, 'no job survives shutdown')
    const error = await rejection(jobs.start(packB),
        'start after shutdown')
    assert(error instanceof Error,
        'starts are rejected once shutdown has been requested')
    // shutdown is idempotent and resolves even with no job left
    await jobs.shutdown()
}

// --- shutdown with a pending lease cannot start the native transfer ---

{
    let downloadCalled = false
    let releaseCalls = 0
    const prepareDeferred = deferred()
    const jobs = new TestJobs({
        prepareVoicePackChange: async () => {
            await prepareDeferred.promise
            return () => { releaseCalls++ }
        },
        download: async () => { downloadCalled = true },
    })
    const promise = jobs.start(pack)
    await flush()
    const closing = jobs.shutdown()
    prepareDeferred.resolve()
    await closing
    const snapshot = await promise
    assert(snapshot.status === 'cancelled',
        'shutdown of a pending-preparation job settles cancelled')
    assert(!downloadCalled,
        'a cancelled shutdown never starts a native transfer after the '
        + 'late lease acquisition')
    assert(releaseCalls === 1, 'the late lease is released exactly once')
}

// Terminal notifications must observe an idle manager and a released gate;
// otherwise a live chooser remains stuck busy after completion.
{
    let lateProgress
    let released = false
    const jobs = new TestJobs({
        prepareVoicePackChange: async () => () => { released = true },
        download: async (_, progress) => { lateProgress = progress },
    })
    jobs.subscribe(snapshot => {
        if (snapshot.status !== 'installed') return
        assert(released && jobs.active === null,
            'terminal subscribers see the released gate and idle manager')
    })
    await jobs.start(pack)
    lateProgress(0.9)
    assert(jobs.get(pack.id).progress === null,
        'late transfer progress cannot modify a settled snapshot')
}

// --- invalid or missing arguments reject without buying a lease ---

{
    const jobs = new TestJobs({
        prepareVoicePackChange: async () => () => {},
        download: async () => {},
        repairPack: async () => {},
    })
    const noPack = await rejection(jobs.start(null), 'missing pack')
    assert(noPack instanceof Error, 'a missing pack is rejected')
    const badKind = await rejection(jobs.start(pack, 'delete'), 'bad kind')
    assert(badKind instanceof Error, 'an unknown kind is rejected')
    assert(jobs.active === null, 'rejected starts own no job')
}

// --- singleton and unused-shutdown contract ---

{
    await shutdownVoicePackJobs() // resolves even when never used
    const singleton = getVoicePackJobs()
    assert(singleton instanceof VoicePackJobs,
        'the production singleton is a VoicePackJobs instance')
    assert(getVoicePackJobs() === singleton,
        'getVoicePackJobs returns the same instance')
    await shutdownVoicePackJobs() // resolves with no active job
}

if (failures) {
    printerr(`${failures} test${failures > 1 ? 's' : ''} failed`)
    exit(1)
}
print('All tests passed')
