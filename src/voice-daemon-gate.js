import GLib from 'gi://GLib'

// Mutation gate for voice pack file changes. Every native reader (a CLI
// synthesis subprocess, a readiness probe, or a daemon synthesis request)
// holds a read lease for as long as it may touch a model. A pack change
// closes the gate first, so no new reader starts while files are replaced,
// then waits for the readers that already hold a lease to settle. The
// caller releases the gate in a finally block, so the gate covers
// publication and rollback, not only the daemon shutdown.
//
// A closed gate rejects new readers and lazy daemon startup with the stable
// `mutation-in-progress` code; a wedged reader rejects the change with
// `settle-timeout` instead of blocking a pack change forever.

const MUTATION_IN_PROGRESS = 'mutation-in-progress'
const SETTLE_TIMEOUT = 'settle-timeout'

export const codedError = (code, message) => {
    const error = new Error(message)
    error.code = code
    return error
}

let gateClosed = false
let activeReaders = 0
const settleWaiters = new Set()

export const isMutationInProgress = () => gateClosed

// Take a read lease: throws while a pack change owns the gate. The returned
// function releases the lease exactly once and wakes a waiting mutation.
export const acquireReadLease = () => {
    if (gateClosed)
        throw codedError(MUTATION_IN_PROGRESS,
            'a voice pack change is in progress')
    activeReaders += 1
    let released = false
    return () => {
        if (released) return
        released = true
        activeReaders -= 1
        if (activeReaders === 0) {
            const waiting = [...settleWaiters]
            settleWaiters.clear()
            for (const settle of waiting) settle()
        }
    }
}

// Resolve when every read lease has been released. A timeout rejects rather
// than hanging a pack change behind a wedged reader; the caller releases the
// gate itself.
export const waitForReaders = (timeoutMs = 5000) => {
    if (activeReaders === 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
        let timer = null
        const settle = () => {
            settleWaiters.delete(settle)
            if (timer !== null) {
                GLib.source_remove(timer)
                timer = null
            }
            resolve()
        }
        settleWaiters.add(settle)
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, timeoutMs, () => {
            timer = null
            settleWaiters.delete(settle)
            reject(codedError(SETTLE_TIMEOUT,
                `voice readers did not settle within ${timeoutMs} ms`))
            return GLib.SOURCE_REMOVE
        })
    })
}

// Close the gate synchronously, so no reader can slip in between the
// decision and the mutation. Returns the release function; a failed
// preparation must call it before rethrowing.
export const beginMutation = () => {
    if (gateClosed)
        throw codedError(MUTATION_IN_PROGRESS,
            'a voice pack change is already in progress')
    gateClosed = true
    let released = false
    return () => {
        if (released) return
        released = true
        gateClosed = false
    }
}
