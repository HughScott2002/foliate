import GLib from 'gi://GLib'
import Gio from 'gi://Gio'
import Soup from 'gi://Soup?version=3.0'

// Voice packs for local neural TTS. Each entry describes a downloadable
// model tarball (sherpa-onnx) unpacked under the app's data dir.

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

export const packDir = id => {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Invalid voice pack ID')
    return GLib.build_filenamev([voicesDir(), id])
}

export const getInstalledPacks = () => getPacks().filter(verifyPack)

// A pack is verified if every expected entry exists as a regular file or
// directory inside the unpacked pack directory.
const verifyDirectory = (pack, dir) => {
    const root = Gio.File.new_for_path(dir)
    if (root.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
        !== Gio.FileType.DIRECTORY) return false
    return pack.expectedFiles.every(name => {
        const type = root.resolve_relative_path(name).query_file_type(
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null)
        return type === (['dict', 'espeak-ng-data'].includes(name)
            ? Gio.FileType.DIRECTORY : Gio.FileType.REGULAR)
    })
}
export const verifyPack = pack => verifyDirectory(pack, packDir(pack.id))

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
    const staging = Gio.File.new_for_path(`${dir}.staging-${GLib.uuid_string_random()}`)
    const part = Gio.File.new_for_path(`${staging.get_path()}.part`)
    activeDownloads.add(pack.id)
    let out = null
    let unpack = null
    let body = null
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
        staging.move(packDirFile, Gio.FileCopyFlags.NONE, null, null)
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
        try {
            if (staging.query_exists(null)) deleteFile(staging)
        } finally { activeDownloads.delete(pack.id) }
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
