import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import Soup from 'gi://Soup?version=3.0'
import { gettext as _ } from 'gettext'

// Voice packs for local neural TTS. Each entry describes a downloadable
// model tarball (sherpa-onnx) unpacked under the app's data dir.

// Canonical Supertonic 3 narrator catalogue. SID order is the model's
// voice.bin index; presets are the official style file codes. The names are
// Foliate labels and the descriptions follow Supertonic's voice guide.
// gettext calls stay literal here so translation extraction can find them.
export const NARRATORS = [
    { sid: 0, preset: 'f1', name: _('Amy'), description: _('Calm and steady') },
    { sid: 1, preset: 'f2', name: _('Lily'), description: _('Bright and playful') },
    { sid: 2, preset: 'f3', name: _('Clara'), description: _('Clear announcer') },
    { sid: 3, preset: 'f4', name: _('Vivian'), description: _('Crisp and confident') },
    { sid: 4, preset: 'f5', name: _('Grace'), description: _('Kind and gentle') },
    { sid: 5, preset: 'm1', name: _('Leo'), description: _('Lively and upbeat') },
    { sid: 6, preset: 'm2', name: _('Graham'), description: _('Deep and composed') },
    { sid: 7, preset: 'm3', name: _('Victor'), description: _('Authoritative and polished') },
    { sid: 8, preset: 'm4', name: _('Elliot'), description: _('Gentle and friendly') },
    { sid: 9, preset: 'm5', name: _('Theo'), description: _('Warm storyteller') },
]

const narratorFor = sid => Number.isInteger(sid) ? NARRATORS[sid] : undefined

export const narratorLabel = sid => {
    const { name, description } = narratorFor(sid) ?? NARRATORS[0]
    return `${name} — ${description}`
}

export const presetCodeForSid = sid =>
    (narratorFor(sid) ?? NARRATORS[0]).preset

export const resolveNarratorSid = ({ stored = null, globalSid = null } = {}) => {
    if (narratorFor(stored)) return { sid: stored, followsDefault: false }
    return { sid: narratorFor(globalSid) ? globalSid : 0, followsDefault: true }
}

// Data dir: ~/.local/share/foliate/voices/<id> per the plan spec — this
// deliberately does NOT mirror pkg.datadir ('com.github.johnfactotum.Foliate').
// Resolution is lazy so tests can repoint XDG_DATA_HOME at a temp dir.
const voicesDir = () =>
    GLib.build_filenamev([GLib.get_user_data_dir(), 'foliate', 'voices'])

// SHA-256 pins match upstream GitHub release asset digests.
// `default: true` marks the pack auto-selected when the user has not
// picked one; exactly one pack has it.
// `expectedFiles` names what sherpa-onnx needs after unpacking: each entry
// is a required file or a required directory (e.g. 'espeak-ng-data').
export const getPacks = () => [{
    id: 'kokoro',
    label: 'Kokoro (multi-language)',
    sizeMB: 141,
    languages: ['en', 'zh'],
    sid: 23,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2',
    sha256: 'a1e94694776049035c4f2c6529f003aaece993c76aae9a78995831c3c4dcafc6',
    sample: 'Hello! This is a sample of the Kokoro voice.',
    expectedFiles: [
        'model.int8.onnx',
        'voices.bin',
        'tokens.txt',
        'lexicon-us-en.txt',
        'lexicon-gb-en.txt',
        'lexicon-zh.txt',
        'dict',
        'espeak-ng-data',
    ],
}, {
    id: 'supertonic',
    label: 'Supertonic 3 (31 languages)',
    sizeMB: 123,
    languages: [
        'en', 'ko', 'ja', 'ar', 'bg', 'cs', 'da', 'de', 'el', 'es',
        'et', 'fi', 'fr', 'hi', 'hr', 'hu', 'id', 'it', 'lt', 'lv',
        'nl', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'tr', 'uk', 'vi',
    ],
    sid: 0,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2',
    sha256: '82fa96f91c4ef8abaae3a14a3f4153facf88bed821d1f7331cec2700f432c427',
    default: true,
    sample: 'Hello! This is a sample of the Supertonic voice.',
    expectedFiles: [
        'text_encoder.int8.onnx',
        'duration_predictor.int8.onnx',
        'vector_estimator.int8.onnx',
        'vocoder.int8.onnx',
        'tts.json',
        'unicode_indexer.bin',
        'voice.bin',
    ],
}, {
    id: 'piper',
    label: 'Piper (en_US-amy-low)',
    sizeMB: 64,
    languages: ['en'],
    sid: 0,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-low.tar.bz2',
    sha256: 'c70f5284a09a7fd4ed203b39b2ff51cac1432b422b852eb647b481dade3cf639',
    sample: 'Hello! This is a sample of the Piper voice.',
    expectedFiles: ['en_US-amy-low.onnx', 'tokens.txt', 'espeak-ng-data'],
}]

export const pickPackForLanguage = language => {
    const primary = (language || 'en').toLowerCase().split(/[-_]/)[0]
    return getPacks().find(pack => pack.languages.includes(primary))
}

// Which pack to narrate a book with, in priority order:
//   1. the pack the user saved for this book
//   2. the installed default pack (supertonic)
//   3. an installed pack that supports the book's language
//   4. the default pack, even if not installed (drives a download prompt)
//   5. any pack (installed or not) that supports the book's language
export const choosePack = ({ saved = null, language = 'en' } = {}) => {
    const primary = (language || 'en').toLowerCase().split(/[-_]/)[0]
    const installed = getInstalledPacks()
    return getPacks().find(pack => pack.id === saved)
        ?? installed.find(pack => pack.default)
        ?? installed.find(pack => pack.languages.includes(primary))
        ?? getPacks().find(pack => pack.default)
        ?? pickPackForLanguage(primary)
}

export const packDir = id => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Invalid voice pack ID')
    return GLib.build_filenamev([voicesDir(), id])
}

export const getInstalledPacks = () => getPacks().filter(verifyPack)

// A pack is verified if every expected entry exists as a regular file or
// directory inside the unpacked pack directory. Regular files must also be
// non-empty: a zero-byte model or token table is the known corruption
// signature this check exists to catch. This is layout/integrity only, not
// proof that sherpa-onnx can load the model at runtime.
const DIRECTORY_ENTRIES = new Set(['dict', 'espeak-ng-data'])
const inspectDirectory = (pack, dir) => {
    const root = Gio.File.new_for_path(dir)
    let type
    try {
        type = root.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
    } catch {
        return { valid: false, message: 'Voice pack directory cannot be read.' }
    }
    if (type !== Gio.FileType.DIRECTORY)
        return { valid: false, message: 'Voice pack path is not a directory.' }
    const problems = []
    for (const name of pack.expectedFiles) {
        const wantsDirectory = DIRECTORY_ENTRIES.has(name)
        try {
            const info = root.resolve_relative_path(name).query_info(
                'standard::type,standard::size',
                Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
            const actual = info.get_file_type()
            if (actual !== (wantsDirectory
                ? Gio.FileType.DIRECTORY : Gio.FileType.REGULAR)) {
                problems.push(`${name} is not a ${wantsDirectory
                    ? 'directory' : 'regular file'}`)
                continue
            }
            if (!wantsDirectory && info.get_size() === 0)
                problems.push(`${name} is empty`)
        } catch {
            problems.push(`${name} is missing`)
        }
    }
    return {
        valid: problems.length === 0,
        message: problems.length
            ? `Voice pack is incomplete: ${problems.join('; ')}` : null,
    }
}
const verifyDirectory = (pack, dir) => inspectDirectory(pack, dir).valid
export const verifyPack = pack => verifyDirectory(pack, packDir(pack.id))

// Cheap synchronous state for the chooser: installed means the pack layout
// and integrity checks pass, not that the backend has loaded the model.
// Missing means the pack directory is absent; an existing but incomplete or
// empty directory is invalid and repairable.
export const getPackState = pack => {
    const dir = packDir(pack.id)
    if (!Gio.File.new_for_path(dir).query_exists(null))
        return { status: 'missing', message: null }
    const { valid, message } = inspectDirectory(pack, dir)
    return valid
        ? { status: 'installed', message: null }
        : { status: 'invalid', message }
}

// gjs 1.86 does not promise-wrap introspection methods whose callback
// parameter is nullable — every libsoup async call is shaped that way —
// so the async calls below use explicit callbacks wrapped in promises.
const gioAsync = (object, method, finish, ...args) =>
    new Promise((resolve, reject) => {
        object[method](...args, (source, result) => {
            try {
                resolve(object[finish](result))
            } catch (error) {
                reject(error)
            }
        })
    })

// One shared session for every pack download: libsoup's recommended
// pattern, and it keeps the teardown of failed or cancelled requests on
// one long-lived object instead of on a session collected mid-flight.
const soupSession = new Soup.Session()

// 64 KiB read chunks for streaming the tarball
const SIZE_CHUNK = 64 * 1024
const activeDownloads = new Set()

// Stream to a unique temporary file, verify the pinned checksum, extract to
// a staging directory, and validate its layout. Returns the staging file
// without publishing it. Failed or cancelled jobs reap tar and clean only
// their own staging files. Callers own activeDownloads and publication.
const stagePack = async (pack, dir, onProgress = null, cancellable = null) => {
    const staging = Gio.File.new_for_path(
        `${dir}.staging-${GLib.uuid_string_random()}`)
    const part = Gio.File.new_for_path(`${staging.get_path()}.part`)
    let out = null
    let unpack = null
    let body = null
    let keep = false
    try {
        try { part.get_parent().make_directory_with_parents(null) } catch (error) {
            if (error.code !== Gio.IOErrorEnum.EXISTS) throw error
        }
        out = part.replace(null, false, Gio.FileCreateFlags.NONE, null)
        const message = Soup.Message.new('GET', pack.url)
        if (message === null)
            throw new Error(`invalid pack URL: ${pack.url}`)
        body = await gioAsync(soupSession, 'send_async', 'send_finish',
            message, GLib.PRIORITY_DEFAULT, cancellable)
        // error pages stream a body that would only fail later as a
        // cryptic tar error: reject here instead
        const status = message.get_status()
        if (status !== Soup.Status.OK)
            throw new Error(`HTTP ${status} for ${pack.url}`)
        // soup_message_headers_get_content_length is deprecated upstream,
        // but still present in libsoup 3.6.6
        const total = message.get_response_headers().get_content_length()
        const sum = new GLib.Checksum(GLib.ChecksumType.SHA256)
        let received = 0
        let bytes
        while ((bytes = await gioAsync(body, 'read_bytes_async',
            'read_bytes_finish', SIZE_CHUNK, GLib.PRIORITY_DEFAULT,
            cancellable)).get_size() > 0) {
            const data = bytes.get_data()
            let offset = 0
            while (offset < data.length) {
                const written = await gioAsync(out, 'write_bytes_async', 'write_bytes_finish',
                    new GLib.Bytes(data.subarray(offset)), GLib.PRIORITY_DEFAULT, cancellable)
                if (!written) throw new Error('Voice download could not be written to disk')
                offset += written
            }
            sum.update(data)
            received += bytes.get_size()
            if (onProgress && total > 0)
                onProgress(Math.min(received / total, 1))
        }
        if (total > 0 && received !== total)
            throw new Error(`size mismatch for ${pack.id}: ` +
                `got ${received} of ${total} bytes`)
        await out.close(null)
        out = null
        const digest = sum.get_string()
        if (digest.toLowerCase() !== pack.sha256.toLowerCase())
            throw new Error(`checksum mismatch for ${pack.id}: ` +
                `got ${digest}, expected ${pack.sha256}`)
        staging.make_directory(null)
        unpack = Gio.Subprocess.new(
            ['tar', '-xjf', part.get_path(), '--strip-components=1',
                '--no-same-owner', '--no-same-permissions', '-C', staging.get_path()],
            Gio.SubprocessFlags.STDOUT_SILENCE |
            Gio.SubprocessFlags.STDERR_SILENCE)
        await gioAsync(unpack, 'wait_check_async', 'wait_check_finish',
            cancellable)
        // a weird layout must fail loudly here, not install a broken pack
        if (!verifyDirectory(pack, staging.get_path()))
            throw new Error(`unpacked ${pack.id} is missing expected files`)
        cancellable?.set_error_if_cancelled()
        keep = true
        return staging
    } catch (error) {
        // a cancelled wait leaves tar running: stop it before deleting the
        // files it may still be extracting
        if (unpack) {
            unpack.force_exit()
            try {
                await gioAsync(unpack, 'wait_async', 'wait_finish', null)
            } catch { /* nothing left to reap */ }
        }
        throw error
    } finally {
        try { body?.close(null) } catch { /* ignore */ }
        try { out?.close(null) } catch { /* ignore */ }
        try { part.delete(null) } catch { /* nothing staged */ }
        if (!keep) {
            try {
                if (staging.query_exists(null)) deleteFile(staging)
            } catch { /* nothing staged */ }
        }
    }
}

const cleanupStaging = staging => {
    try {
        if (staging?.query_exists(null)) deleteFile(staging)
    } catch { /* nothing staged */ }
}

// Stream to a unique temporary file, verify the pinned checksum, extract to
// a staging directory, validate its layout, then rename atomically. Never
// expose a partially extracted pack or overwrite an existing model. Failed
// or cancelled jobs reap tar before cleaning only their own staging files.
export const download = async (pack, onProgress = null, cancellable = null) => {
    const dir = packDir(pack.id)
    if (!/^[0-9a-f]{64}$/i.test(pack.sha256 ?? ''))
        throw new Error(`Missing pinned checksum for ${pack.id}`)
    if (activeDownloads.has(pack.id))
        throw new Error(`A download is already in progress for ${pack.id}`)
    const packDirFile = Gio.File.new_for_path(dir)
    if (packDirFile.query_exists(null))
        throw new Error(`Voice directory already exists: ${pack.id}. Remove it before downloading again.`)
    activeDownloads.add(pack.id)
    let staging = null
    try {
        staging = await stagePack(pack, dir, onProgress, cancellable)
        // keep the refusal friendly if another process created the target
        if (packDirFile.query_exists(null))
            throw new Error(`Voice directory already exists: ${pack.id}. Remove it before downloading again.`)
        staging.move(packDirFile, Gio.FileCopyFlags.NONE, null, null)
        staging = null
    } finally {
        cleanupStaging(staging)
        activeDownloads.delete(pack.id)
    }
}

// Repair a missing or invalid pack without ever publishing a partial one.
// The archive checksum and unpacked layout are verified in staging before the
// current directory is moved aside. On success the previous directory stays
// as a uniquely named backup; on cancellation or failure the previous
// directory (or its backup) is left intact. The caller owns the explicit
// destructive confirmation and must settle in-flight backend use first.
export const repairPack = async (pack, onProgress = null, cancellable = null) => {
    const dir = packDir(pack.id)
    if (!/^[0-9a-f]{64}$/i.test(pack.sha256 ?? ''))
        throw new Error(`Missing pinned checksum for ${pack.id}`)
    if (activeDownloads.has(pack.id))
        throw new Error(`A download is already in progress for ${pack.id}`)
    activeDownloads.add(pack.id)
    const dirFile = Gio.File.new_for_path(dir)
    let staging = null
    try {
        staging = await stagePack(pack, dir, onProgress, cancellable)
        let backup = null
        let movedAside = false
        try {
            if (dirFile.query_exists(null)) {
                backup = Gio.File.new_for_path(
                    `${dir}.backup-${GLib.uuid_string_random()}`)
                dirFile.move(backup, Gio.FileCopyFlags.NONE, null, null)
                movedAside = true
            }
            cancellable?.set_error_if_cancelled()
            staging.move(dirFile, Gio.FileCopyFlags.NONE, null, null)
            staging = null
        } catch (error) {
            let rollbackNote = ''
            if (movedAside) {
                try {
                    backup.move(dirFile, Gio.FileCopyFlags.NONE, null, null)
                } catch (rollbackError) {
                    rollbackNote = `; rollback failed, previous pack kept at ` +
                        `${backup.get_path()}: ${rollbackError.message}`
                }
            }
            if (rollbackNote)
                throw new Error(`${error.message}${rollbackNote}`)
            throw error
        }
    } finally {
        cleanupStaging(staging)
        activeDownloads.delete(pack.id)
    }
}

const deleteFile = file => {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
            === Gio.FileType.DIRECTORY) {
        const children = file.enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NONE, null)
        try {
            let info
            while ((info = children.next_file(null)) != null)
                deleteFile(file.get_child(info.get_name()))
        } finally {
            children.close(null)
        }
    }
    return file.delete(null)
}

export const deletePack = id => {
    const file = Gio.File.new_for_path(packDir(id))
    return file.query_exists(null) && deleteFile(file)
}
