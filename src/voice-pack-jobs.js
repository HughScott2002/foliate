import Gio from 'gi://Gio'
import { download, repairPack } from './voice-packs.js'
import { prepareVoicePackChange } from './voice-daemon.js'

// App-process owner for background voice pack transfers. Personal dialog
// state (preview, readiness, removal, explicit Use) stays dialog-local in
// voice-manager.js; this module owns only the shared download/repair
// lifecycle so a chooser can close and reopen (or open in another book)
// and see the same running or retained terminal job.
//
// Every transfer holds one mutation lease — prepareVoicePackChange() ->
// release() — across its entire lifetime, including network, publication
// and rollback, and releases it exactly once in a finally block after
// settlement. Cancellation is checked after preparation and before the
// native transfer starts, so a cancel or shutdown that arrives while the
// lease is still pending can never start a transfer.
//
// Snapshots are plain detached copies; subscriber exceptions never touch
// job state. There are no widgets or book references here.

export class VoicePackJobs {
    #operations
    // packId -> retained record (running or settled terminal state)
    #jobs = new Map()
    #runningJob = null
    #listeners = new Set()
    #shutdownPromise = null
    #shuttingDown = false

    constructor(operations = {}) {
        this.#operations = {
            download: operations.download ?? download,
            repairPack: operations.repairPack ?? repairPack,
            prepareVoicePackChange:
                operations.prepareVoicePackChange ?? prepareVoicePackChange,
        }
    }

    // { packId, kind, status, progress, error } or null.
    get(id) {
        const job = this.#jobs.get(id)
        return job ? this.#snapshot(job) : null
    }

    // The running snapshot, or null.
    get active() {
        const job = this.#runningJob
        return job ? this.#snapshot(job) : null
    }

    // Listeners are called on every state change with a detached snapshot.
    // Returns the unsubscribe function.
    subscribe(listener) {
        this.#listeners.add(listener)
        return () => this.#listeners.delete(listener)
    }

    // Resolves with the terminal snapshot. A duplicate start of the same
    // running job returns the same promise; any other concurrent start is
    // rejected without touching the existing job.
    start(pack, kind = 'download') {
        const packId = pack?.id
        if (!packId)
            return Promise.reject(new Error('A voice pack id is required.'))
        if (kind !== 'download' && kind !== 'repair')
            return Promise.reject(
                new Error(`Unknown voice pack transfer kind: ${kind}`))
        if (this.#shuttingDown)
            return Promise.reject(new Error(
                'Voice pack transfers are shutting down.'))
        const running = this.#runningJob
        if (running) {
            if (running.packId === packId && running.kind === kind)
                return running.promise
            return Promise.reject(new Error(
                'A voice pack transfer is already running for '
                + `${running.packId}; ${kind} for ${packId} was refused.`))
        }
        const job = {
            packId, kind,
            status: 'running', progress: null, error: null,
            cancelRequested: false,
            cancellable: new Gio.Cancellable(),
        }
        this.#jobs.set(packId, job)
        this.#runningJob = job
        // Created before any await so duplicate callers share it.
        job.promise = Promise.resolve().then(() => this.#run(pack, job))
        this.#emit(job)
        return job.promise
    }

    // Cancels only the matching active transfer; settled or foreign jobs
    // are unaffected and calls are idempotent.
    cancel(id) {
        const job = this.#runningJob
        if (!job || job.packId !== id) return
        job.cancelRequested = true
        job.cancellable.cancel()
    }

    // Prevents new starts, cancels the owned transfer and awaits its
    // cleanup (lease release included). Idempotent.
    shutdown() {
        if (this.#shutdownPromise) return this.#shutdownPromise
        this.#shuttingDown = true
        const job = this.#runningJob
        if (!job) {
            this.#shutdownPromise = Promise.resolve()
            return this.#shutdownPromise
        }
        // Reuse cancel so the pending lease cannot slip a transfer in.
        this.cancel(job.packId)
        this.#shutdownPromise = job.promise.then(() => {})
        return this.#shutdownPromise
    }

    async #run(pack, job) {
        let release = null
        let status = 'installed'
        let failure = null
        try {
            // One lease for the whole transfer: network included, and it
            // deliberately covers publication and rollback too.
            release = await this.#operations.prepareVoicePackChange()
            // Cancelled while the lease was pending: never touch the pack.
            if (job.cancelRequested) throw new Error('cancelled')
            const op = job.kind === 'repair'
                ? this.#operations.repairPack : this.#operations.download
            await op(pack,
                fraction => this.#update(job, { progress: fraction }),
                job.cancellable)
        } catch (error) {
            status = job.cancelRequested ? 'cancelled' : 'failed'
            failure = job.cancelRequested ? null : error
        } finally {
            // Released exactly once, after settlement and rollback.
            if (release) {
                const settledRelease = release
                release = null
                try { settledRelease() } catch (error) {
                    status = 'failed'
                    failure = error
                }
            }
            if (this.#runningJob === job) this.#runningJob = null
        }
        this.#settle(job, { status, error: failure })
        return this.#snapshot(job)
    }

    #settle(job, patch) {
        this.#update(job, { progress: null, ...patch })
    }

    #update(job, patch) {
        // Late progress events after settlement must not corrupt state.
        if (this.#jobs.get(job.packId) !== job || job.status !== 'running') return
        for (const key of ['status', 'progress', 'error'])
            if (key in patch) job[key] = patch[key]
        this.#emit(job)
    }

    #snapshot(job) {
        return {
            packId: job.packId,
            kind: job.kind,
            status: job.status,
            progress: job.progress,
            error: job.error,
        }
    }

    #emit(job) {
        for (const listener of [...this.#listeners]) {
            try {
                listener(this.#snapshot(job))
            } catch { /* a broken subscriber must not affect job state */ }
        }
    }
}

let singleton = null

// The app-process share. Widgets may call this at any time; the instance
// lives until Foliate exits, retaining terminal snapshots.
export const getVoicePackJobs = () => (singleton ??= new VoicePackJobs())

// No-op when the singleton was never used; resolves after the app's last
// transferred job has released its lease otherwise.
export const shutdownVoicePackJobs = () =>
    singleton?.shutdown() ?? Promise.resolve()
