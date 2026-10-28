import { exit } from 'system'
import GLib from 'gi://GLib'
import Gio from 'gi://Gio'

// Keep test state out of the real ~/.local/share/foliate: repoint
// XDG_DATA_HOME at a temp dir before any packDir() call (resolution is lazy
// inside the module, so this takes effect).
const tmp = GLib.dir_make_tmp(null)
GLib.setenv('XDG_DATA_HOME', tmp, true)

import {
    getPacks,
    packDir,
    verifyPack,
    getInstalledPacks,
    getPackState,
    download,
    repairPack,
    deletePack,
} from '../src/voice-packs.js'

let failures = 0
const assert = (cond, msg) => {
    if (cond) return
    failures++
    printerr(`FAIL: ${msg}`)
}

// read one UTF-8 text fixture or installed-pack file
const readText = path =>
    new TextDecoder().decode(Gio.File.new_for_path(path).load_contents(null)[1])

// names of repair backups retained beside the installed pack directory
const backupsFor = id => {
    const parent = Gio.File.new_for_path(packDir(id)).get_parent()
    const children = parent.enumerate_children(
        'standard::name', Gio.FileQueryInfoFlags.NONE, null)
    const found = []
    try {
        let info
        while ((info = children.next_file(null)) != null) {
            const name = info.get_name()
            if (name.startsWith(`${id}.backup-`))
                found.push(parent.get_child(name).get_path())
        }
    } finally {
        children.close(null)
    }
    return found
}

// staging and .part siblings left by a repair attempt
const stagingFor = id => {
    const parent = Gio.File.new_for_path(packDir(id)).get_parent()
    const children = parent.enumerate_children(
        'standard::name', Gio.FileQueryInfoFlags.NONE, null)
    const found = []
    try {
        let info
        while ((info = children.next_file(null)) != null) {
            const name = info.get_name()
            if (name.startsWith(`${id}.staging-`))
                found.push(parent.get_child(name).get_path())
        }
    } finally {
        children.close(null)
    }
    return found
}

// Inject one deterministic Gio.File.move failure for an isolated repair case.
// The predicate sees the source and destination; returning true throws and
// records that the intended fault fired. The real method is always restored.
const withMoveFault = async (predicate, body) => {
    const original = Gio.File.prototype.move
    const fired = []
    Gio.File.prototype.move = function (destination, ...rest) {
        if (predicate(this, destination)) {
            fired.push({
                source: this.get_path(),
                destination: destination?.get_path?.(),
            })
            throw new Error('injected move failure')
        }
        return original.call(this, destination, ...rest)
    }
    let result
    let error = null
    try {
        result = await body()
    } catch (caught) {
        error = caught
    } finally {
        Gio.File.prototype.move = original
    }
    return { result, error, fired }
}

// recursive delete for cleanup in the finally block below
const rmrf = file => {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null)
            === Gio.FileType.DIRECTORY) {
        const children = file.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null)
        try {
            let info
            while ((info = children.next_file(null)) != null)
                rmrf(file.get_child(info.get_name()))
        } finally {
            children.close(null)
        }
    }
    file.delete(null)
}

// --- fixture: a sherpa-onnx-shaped tarball (kokoro's shape) served over
// loopback http by python's http.server ---
const www = GLib.build_filenamev([GLib.get_user_data_dir(), 'www'])
const stub = GLib.build_filenamev([www, 'stub'])
GLib.mkdir_with_parents(GLib.build_filenamev([stub, 'espeak-ng-data']), 0o755)
GLib.mkdir_with_parents(GLib.build_filenamev([stub, 'dict']), 0o755)
const put = (name, content) =>
    GLib.file_set_contents(GLib.build_filenamev([stub, name]), content)
put('model.int8.onnx', 'fake-model')
// voices.bin is big random noise so the tarball spans several 64 KiB read
// chunks and the progress callback fires more than once
put('voices.bin', Array.from({ length: 40000 }, () =>
    Math.random().toString(36).slice(2, 12)).join('\n'))
put('tokens.txt', 'a b c')
put('lexicon-us-en.txt', 'a=a')
put('lexicon-gb-en.txt', 'a=a')
put('lexicon-zh.txt', 'a=a')
GLib.file_set_contents(
    GLib.build_filenamev([stub, 'espeak-ng-data', 'marker']), 'x')

const tarball = GLib.build_filenamev([www, 'stub.tar.bz2'])
assert(Gio.Subprocess.new(['tar', '-cjf', tarball, '-C', www, 'stub'],
    Gio.SubprocessFlags.NONE).wait_check(null) === true, 'fixture tarball built')

const [fixtureBytes] = Gio.File.new_for_path(tarball).load_bytes(null)
const fixtureSha =
    GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, fixtureBytes)
assert(/^[0-9a-f]{64}$/.test(fixtureSha), 'fixture sha256 computed')

// a second tarball with a valid checksum but a missing expected file:
// repair must reject its layout before replacing the old pack
const badLayout = GLib.build_filenamev([www, 'stub-badlayout'])
GLib.mkdir_with_parents(
    GLib.build_filenamev([badLayout, 'espeak-ng-data']), 0o755)
GLib.mkdir_with_parents(GLib.build_filenamev([badLayout, 'dict']), 0o755)
const putBad = (name, content) =>
    GLib.file_set_contents(GLib.build_filenamev([badLayout, name]), content)
putBad('voices.bin', 'x')
putBad('tokens.txt', 'a b c')
putBad('lexicon-us-en.txt', 'a=a')
putBad('lexicon-gb-en.txt', 'a=a')
putBad('lexicon-zh.txt', 'a=a')
GLib.file_set_contents(
    GLib.build_filenamev([badLayout, 'espeak-ng-data', 'marker']), 'x')
const badLayoutTarball =
    GLib.build_filenamev([www, 'stub-badlayout.tar.bz2'])
assert(Gio.Subprocess.new(
    ['tar', '-cjf', badLayoutTarball, '-C', www, 'stub-badlayout'],
    Gio.SubprocessFlags.NONE).wait_check(null) === true,
'bad-layout fixture tarball built')
const [badLayoutBytes] =
    Gio.File.new_for_path(badLayoutTarball).load_bytes(null)
const badLayoutSha =
    GLib.compute_checksum_for_bytes(GLib.ChecksumType.SHA256, badLayoutBytes)
assert(/^[0-9a-f]{64}$/.test(badLayoutSha), 'bad-layout sha256 computed')

// pick a free port, then serve the fixture directory over loopback http
const probe = Gio.Socket.new(Gio.SocketFamily.IPV4, Gio.SocketType.STREAM,
    Gio.SocketProtocol.TCP)
probe.bind(Gio.InetSocketAddress.new(
    Gio.InetAddress.new_from_string('127.0.0.1'), 0), false)
const port = probe.get_local_address().get_port()
probe.close()

const stubUrl = `http://127.0.0.1:${port}/stub.tar.bz2`

// a fake pack entry: the kokoro entry repointed at the local fixture
const kokoro = getPacks()[0]
const stubPack = {
    ...kokoro,
    id: 'stub',
    url: stubUrl,
    sha256: fixtureSha,
    // what the fixture unpacks to, flat inside packDir('stub')
    expectedFiles: ['model.int8.onnx', 'voices.bin', 'tokens.txt',
        'lexicon-us-en.txt', 'dict', 'espeak-ng-data'],
}

let server = null
try {
    server = Gio.Subprocess.new(
        ['python3', '-m', 'http.server', String(port),
            '--bind', '127.0.0.1', '--directory', www],
        Gio.SubprocessFlags.STDOUT_SILENCE |
        Gio.SubprocessFlags.STDERR_SILENCE)
    // wait for the server to accept connections (plain TCP connect —
    // no Soup messages of its own to tear down)
    const client = new Gio.SocketClient()
    const addr = Gio.InetSocketAddress.new(
        Gio.InetAddress.new_from_string('127.0.0.1'), port)
    const deadline = Date.now() + 5000
    for (;;) {
        try {
            const conn = await new Promise((resolve, reject) => {
                client.connect_async(addr, null, (source, result) => {
                    try {
                        resolve(client.connect_finish(result))
                    } catch (error) {
                        reject(error)
                    }
                })
            })
            conn.close(null)
            break
        } catch (error) {
            if (Date.now() > deadline) throw error
            await new Promise(resolve =>
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50,
                    () => (resolve(), GLib.SOURCE_REMOVE)))
        }
    }

    // a dead URL rejects and leaves nothing behind
    try {
        await download({ ...stubPack, id: 'badurl',
            url: 'http://127.0.0.1:1/nope.tar.bz2' })
        failures++
        printerr('FAIL: download from a dead URL should reject')
    } catch {
        assert(!GLib.file_test(packDir('badurl') + '.part', GLib.FileTest.EXISTS),
            'no .part left behind after a failed download')
    }

    // an HTTP error page fails the download with the status in the message,
    // instead of streaming the error body into a cryptic tar error
    try {
        await download({ ...stubPack, id: 'notfound',
            url: `http://127.0.0.1:${port}/no-such-file.tar.bz2` })
        failures++
        printerr('FAIL: an HTTP 404 should reject')
    } catch (error) {
        assert(/HTTP 404/.test(error.message),
            `404 is reported as an HTTP status error (got: ${error.message})`)
        assert(!GLib.file_test(packDir('notfound') + '.part', GLib.FileTest.EXISTS),
            'no .part left behind after an HTTP error')
    }

    // cancelling from the first progress callback rejects mid-download
    const cancellable = new Gio.Cancellable()
    let progressCalls = 0
    try {
        await download({ ...stubPack, id: 'cancel-me' }, () => {
            if (++progressCalls === 1) cancellable.cancel()
        }, cancellable)
        failures++
        printerr('FAIL: a cancelled download should reject')
    } catch (error) {
        assert(/cancel/i.test(error.message),
            `cancelled download rejects with a cancel error (got: ${error.message})`)
    }
    assert(progressCalls >= 1, 'progress fired before the cancel landed')
    assert(!GLib.file_test(packDir('cancel-me') + '.part', GLib.FileTest.EXISTS),
        'no .part left behind after a cancel')
    assert(!GLib.file_test(packDir('cancel-me'), GLib.FileTest.EXISTS),
        'no pack dir after a cancel')

    // happy path: the download resolves, progress is monotonic 0..1
    const fractions = []
    await download(stubPack, fraction => fractions.push(fraction))
    assert(fractions.length >= 2, 'progress fires for every 64 KiB chunk')
    assert(fractions.every(f => f >= 0 && f <= 1), 'fractions stay in 0..1')
    assert(fractions.every((f, i) => i === 0 || f >= fractions[i - 1]),
        'progress is monotonic')
    assert(fractions[fractions.length - 1] === 1, 'progress ends at 1')

    // the tarball's top-level dir is stripped: files land flat in packDir
    for (const name of stubPack.expectedFiles) {
        const path = GLib.build_filenamev([packDir('stub'), name])
        const isDir = name === 'dict' || name === 'espeak-ng-data'
        assert(GLib.file_test(path, isDir
            ? GLib.FileTest.IS_DIR : GLib.FileTest.IS_REGULAR),
        `unpacked ${name} lands flat in packDir('stub')`)
    }
    assert(!GLib.file_test(GLib.build_filenamev([packDir('stub'), 'stub']),
        GLib.FileTest.EXISTS), 'the top-level stub dir was stripped')
    assert(verifyPack(stubPack) === true, 'verifyPack true after download')

    const existing = { ...stubPack, id: 'existing' }
    GLib.mkdir_with_parents(packDir(existing.id), 0o755)
    GLib.file_set_contents(`${packDir(existing.id)}/tokens.txt`, 'keep me')
    try {
        await download(existing)
        assert(false, 'download must not overwrite a preexisting pack directory')
    } catch (error) {
        assert(/already exists/i.test(error.message), 'preexisting pack reports recovery action')
    }
    assert(new TextDecoder().decode(Gio.File.new_for_path(
        `${packDir(existing.id)}/tokens.txt`).load_contents(null)[1]) === 'keep me',
    'preexisting model files preserved')
    try {
        await download({ ...stubPack, id: 'unsigned', sha256: null })
        assert(false, 'unsigned voice downloads must reject')
    } catch (error) {
        assert(/checksum/i.test(error.message), 'unsigned download explains missing checksum')
    }

    // a wrong pinned checksum fails the download and leaves nothing behind
    try {
        await download({ ...stubPack, id: 'badsum', sha256: '0'.repeat(64) })
        failures++
        printerr('FAIL: a mismatched checksum should reject')
    } catch (error) {
        assert(/checksum/i.test(error.message),
            `checksum failure reports the mismatch (got: ${error.message})`)
        assert(!GLib.file_test(packDir('badsum') + '.part', GLib.FileTest.EXISTS),
            'no .part left behind after a checksum failure')
        assert(!GLib.file_test(packDir('badsum'), GLib.FileTest.EXISTS),
            'no pack dir after a checksum failure')
    }

    // repair a missing pack: no previous directory, so no backup is kept
    const missingId = 'repair-missing'
    const missingEntry = { ...stubPack, id: missingId }
    assert(getPackState(missingEntry).status === 'missing',
        'repair target starts missing')
    await repairPack(missingEntry)
    assert(verifyPack(missingEntry) === true, 'repair installs a missing pack')
    assert(getPackState(missingEntry).status === 'installed',
        'repaired missing pack reports installed')
    assert(backupsFor(missingId).length === 0,
        'repairing a missing pack creates no backup')
    assert(deletePack(missingId) === true, 'repaired missing pack deleted')

    // repair an invalid pack: old bytes survive in a unique retained backup
    const installedId = 'repair-installed'
    const installedEntry = { ...stubPack, id: installedId }
    GLib.mkdir_with_parents(packDir(installedId), 0o755)
    GLib.file_set_contents(`${packDir(installedId)}/tokens.txt`, 'old tokens')
    GLib.file_set_contents(`${packDir(installedId)}/model.int8.onnx`, '')
    assert(getPackState(installedEntry).status === 'invalid',
        'repair target starts invalid')
    await repairPack(installedEntry)
    assert(verifyPack(installedEntry) === true, 'repair replaces invalid content')
    assert(getPackState(installedEntry).status === 'installed',
        'repaired pack reports installed')
    const installedBackups = backupsFor(installedId)
    assert(installedBackups.length === 1,
        `repair keeps one previous-directory backup (got ${installedBackups.length})`)
    assert(readText(`${installedBackups[0]}/tokens.txt`) === 'old tokens',
        'backup keeps the previous pack bytes')
    assert(readText(`${packDir(installedId)}/tokens.txt`) === 'a b c',
        'repaired pack carries the verified archive bytes')
    assert(stagingFor(installedId).length === 0,
        'repair leaves no staging directory behind')
    assert(deletePack(installedId) === true, 'repaired installed pack deleted')

    // a checksum failure during repair leaves the previous directory intact
    const badsumRepairId = 'repair-badsum'
    GLib.mkdir_with_parents(packDir(badsumRepairId), 0o755)
    GLib.file_set_contents(
        `${packDir(badsumRepairId)}/tokens.txt`, 'keep checksum repair')
    try {
        await repairPack({ ...stubPack, id: badsumRepairId,
            sha256: '0'.repeat(64) })
        failures++
        printerr('FAIL: a repair with a bad checksum should reject')
    } catch (error) {
        assert(/checksum/i.test(error.message),
            `repair checksum failure reports the mismatch (got: ${error.message})`)
    }
    assert(readText(`${packDir(badsumRepairId)}/tokens.txt`)
        === 'keep checksum repair', 'failed repair keeps the previous bytes')
    assert(backupsFor(badsumRepairId).length === 0,
        'failed checksum repair creates no backup')
    assert(stagingFor(badsumRepairId).length === 0,
        'failed checksum repair leaves no staging directory')
    assert(deletePack(badsumRepairId) === true, 'failed repair target deleted')

    // cancelling a repair mid-download leaves the previous directory intact
    const cancelRepairId = 'repair-cancel'
    GLib.mkdir_with_parents(packDir(cancelRepairId), 0o755)
    GLib.file_set_contents(
        `${packDir(cancelRepairId)}/tokens.txt`, 'keep cancelled repair')
    const repairCancellable = new Gio.Cancellable()
    let repairProgressCalls = 0
    try {
        await repairPack({ ...stubPack, id: cancelRepairId }, () => {
            if (++repairProgressCalls === 1) repairCancellable.cancel()
        }, repairCancellable)
        failures++
        printerr('FAIL: a cancelled repair should reject')
    } catch (error) {
        assert(/cancel/i.test(error.message),
            `cancelled repair rejects with a cancel error (got: ${error.message})`)
    }
    assert(repairProgressCalls >= 1,
        'repair progress fired before the cancel landed')
    assert(readText(`${packDir(cancelRepairId)}/tokens.txt`)
        === 'keep cancelled repair', 'cancelled repair keeps the previous bytes')
    assert(backupsFor(cancelRepairId).length === 0,
        'cancelled repair creates no backup')
    assert(stagingFor(cancelRepairId).length === 0,
        'cancelled repair leaves no staging directory')
    assert(deletePack(cancelRepairId) === true, 'cancelled repair target deleted')

    // a valid checksum with an incomplete layout is rejected before replacement
    const layoutRepairId = 'repair-layout'
    GLib.mkdir_with_parents(packDir(layoutRepairId), 0o755)
    GLib.file_set_contents(
        `${packDir(layoutRepairId)}/tokens.txt`, 'keep layout repair')
    try {
        await repairPack({ ...stubPack, id: layoutRepairId,
            sha256: badLayoutSha,
            url: `http://127.0.0.1:${port}/stub-badlayout.tar.bz2` })
        failures++
        printerr('FAIL: a repair with an incomplete layout should reject')
    } catch (error) {
        assert(/missing expected files/i.test(error.message),
            `repair layout failure names missing files (got: ${error.message})`)
    }
    assert(readText(`${packDir(layoutRepairId)}/tokens.txt`)
        === 'keep layout repair', 'layout failure keeps the previous bytes')
    assert(backupsFor(layoutRepairId).length === 0,
        'layout failure creates no backup')
    assert(stagingFor(layoutRepairId).length === 0,
        'layout failure leaves no staging directory')
    assert(deletePack(layoutRepairId) === true, 'layout failure target deleted')

    // failure moving the old pack to its backup leaves the original in place
    const backupFaultId = 'repair-backup-fault'
    GLib.mkdir_with_parents(packDir(backupFaultId), 0o755)
    GLib.file_set_contents(
        `${packDir(backupFaultId)}/tokens.txt`, 'keep backup fault')
    const backupFault = await withMoveFault(
        (source, destination) =>
            source.get_path() === packDir(backupFaultId) &&
            destination?.get_path?.().startsWith(
                `${packDir(backupFaultId)}.backup-`),
        () => repairPack({ ...stubPack, id: backupFaultId }))
    assert(backupFault.fired.length === 1,
        'injected fault fired while moving the old pack to backup')
    assert(backupFault.error instanceof Error,
        'failed move to backup rejects repairPack')
    assert(/injected move failure/i.test(backupFault.error.message),
        `failed move to backup reports the injected fault (got: ${backupFault.error.message})`)
    assert(readText(`${packDir(backupFaultId)}/tokens.txt`)
        === 'keep backup fault', 'old bytes survive a failed move to backup')
    assert(backupsFor(backupFaultId).length === 0,
        'failed move to backup leaves no backup directory')
    assert(stagingFor(backupFaultId).length === 0,
        'failed move to backup cleans staging')
    assert(getPackState({ ...stubPack, id: backupFaultId }).status === 'invalid',
        'failed backup move leaves the original invalid pack in place')
    assert(deletePack(backupFaultId) === true, 'backup-fault target deleted')

    // failure publishing staging after the backup succeeded restores the old pack
    const publishFaultId = 'repair-publish-fault'
    GLib.mkdir_with_parents(packDir(publishFaultId), 0o755)
    GLib.file_set_contents(
        `${packDir(publishFaultId)}/tokens.txt`, 'keep publish fault')
    const publishFault = await withMoveFault(
        (source, destination) =>
            source.get_path().startsWith(`${packDir(publishFaultId)}.staging-`) &&
            destination?.get_path?.() === packDir(publishFaultId),
        () => repairPack({ ...stubPack, id: publishFaultId }))
    assert(publishFault.fired.length === 1,
        'injected fault fired while publishing staging after backup succeeded')
    assert(publishFault.error instanceof Error,
        'failed staging publication rejects repairPack')
    assert(/injected move failure/i.test(publishFault.error.message),
        `failed staging publication reports the injected fault (got: ${publishFault.error.message})`)
    assert(readText(`${packDir(publishFaultId)}/tokens.txt`)
        === 'keep publish fault', 'old bytes restored after failed staging publication')
    assert(getPackState({ ...stubPack, id: publishFaultId }).status === 'invalid',
        'restored pack is still the original invalid pack')
    assert(backupsFor(publishFaultId).length === 0,
        'successful rollback leaves no backup directory')
    assert(stagingFor(publishFaultId).length === 0,
        'failed staging publication cleans staging')
    assert(deletePack(publishFaultId) === true, 'publish-fault target deleted')

    // failure rolling back retains the backup and reports its recoverable path
    const rollbackFaultId = 'repair-rollback-fault'
    GLib.mkdir_with_parents(packDir(rollbackFaultId), 0o755)
    GLib.file_set_contents(
        `${packDir(rollbackFaultId)}/tokens.txt`, 'keep rollback fault')
    const rollbackFault = await withMoveFault(
        (source, destination) => {
            const from = source.get_path()
            const to = destination?.get_path?.()
            return (from.startsWith(`${packDir(rollbackFaultId)}.staging-`) &&
                    to === packDir(rollbackFaultId)) ||
                (from.startsWith(`${packDir(rollbackFaultId)}.backup-`) &&
                    to === packDir(rollbackFaultId))
        },
        () => repairPack({ ...stubPack, id: rollbackFaultId }))
    assert(rollbackFault.fired.length === 2,
        'injected faults fired for staging publication and rollback')
    assert(rollbackFault.error instanceof Error,
        'failed rollback rejects repairPack')
    assert(/rollback failed/i.test(rollbackFault.error.message),
        `failed rollback is reported (got: ${rollbackFault.error.message})`)
    const rollbackBackups = backupsFor(rollbackFaultId)
    assert(rollbackBackups.length === 1,
        'failed rollback retains exactly one backup')
    assert(rollbackFault.error.message.includes(rollbackBackups[0]),
        'failed rollback reports the recoverable backup path')
    assert(readText(`${rollbackBackups[0]}/tokens.txt`)
        === 'keep rollback fault', 'old bytes survive in the retained backup')
    assert(!GLib.file_test(packDir(rollbackFaultId), GLib.FileTest.EXISTS),
        'failed rollback leaves the original path absent')
    assert(stagingFor(rollbackFaultId).length === 0,
        'failed rollback cleans staging')
    assert(deletePack(rollbackFaultId) === false,
        'failed rollback leaves no installed directory to delete')

    // a non-tarball body passes the download checks but fails the unpack:
    // the staging directory created for it must not survive
    GLib.file_set_contents(GLib.build_filenamev([www, 'notes.txt']),
        'this is not a tarball')
    try {
        await download({
            ...stubPack, id: 'nottar',
            sha256: GLib.compute_checksum_for_string(
                GLib.ChecksumType.SHA256, 'this is not a tarball', -1),
            url: `http://127.0.0.1:${port}/notes.txt`,
        })
        failures++
        printerr('FAIL: a non-tarball body should reject')
    } catch {
        assert(!GLib.file_test(packDir('nottar') + '.part', GLib.FileTest.EXISTS),
            'no .part left behind after a failed unpack')
        assert(!GLib.file_test(packDir('nottar'), GLib.FileTest.EXISTS),
            'no pack dir after a failed unpack')
    }

    // the same fixture downloaded as the real kokoro entry: the catalog
    // picks it up after fixture checksum verification
    await download({ ...kokoro, url: stubUrl, sha256: fixtureSha })
    assert(verifyPack(kokoro) === true, 'verifyPack true for kokoro')
    assert(getInstalledPacks().some(p => p.id === 'kokoro'),
        'getInstalledPacks picks up the downloaded pack')

    assert(deletePack('kokoro') === true, 'deletePack removes it')
    assert(!getInstalledPacks().some(p => p.id === 'kokoro'),
        'kokoro not installed after delete')
    assert(deletePack('stub') === true, 'deletePack removes the stub pack')
    assert(verifyPack(stubPack) === false, 'verifyPack false after delete')
    assert(deletePack('stub') === false, 'deleting again returns false')
} finally {
    if (server) {
        server.force_exit()
        // reap the killed server so no zombie is left behind
        server.wait(null)
    }
    // the whole temp XDG tree goes away with this run, whatever happened
    rmrf(Gio.File.new_for_path(tmp))
}

// wait for libsoup to finish tearing down the connections left behind by
// the failed and cancelled downloads: exiting too early otherwise trips
// its "soup_message_queue_item_destroy" runtime check at process exit
await new Promise(resolve =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250,
        () => (resolve(), GLib.SOURCE_REMOVE)))

if (failures) {
    printerr(`${failures} test${failures > 1 ? 's' : ''} failed`)
    exit(1)
}
print('All tests passed')
