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

// SHA-256 pins are null placeholders: checksum verification of the
// downloads is a separate later pass.
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
    sha256: null,
    sample: 'Hello! This is a sample of the Kokoro voice.',
    default: true,
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
        'en', 'fr', 'de', 'es', 'it', 'pt', 'ru', 'ja', 'ko', 'zh',
        'ar', 'tr', 'hi', 'id', 'vi', 'th', 'pl', 'nl', 'sv', 'da',
        'fi', 'no', 'uk', 'cs', 'el', 'he', 'ro', 'hu', 'bg', 'hr',
        'sk',
    ],
    sid: 0,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/sherpa-onnx-supertonic-3-tts-int8-2026-05-11.tar.bz2',
    sha256: null,
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
    sha256: null,
    sample: 'Hello! This is a sample of the Piper voice.',
    expectedFiles: ['en_US-amy-low.onnx', 'tokens.txt', 'espeak-ng-data'],
}]

export const packDir = id => GLib.build_filenamev([voicesDir(), id])

export const getInstalledPacks = () => getPacks().filter(verifyPack)

// A pack is verified if every expected entry exists as a regular file or
// directory inside the unpacked pack directory.
export const verifyPack = pack => {
    const dir = packDir(pack.id)
    if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) return false
    return pack.expectedFiles.every(name => {
        const path = GLib.build_filenamev([dir, name])
        return GLib.file_test(path, GLib.FileTest.IS_REGULAR) ||
            GLib.file_test(path, GLib.FileTest.IS_DIR)
    })
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

// Streams the pack tarball to `<packDir(id)>.part` with progress callbacks,
// then unpacks it into packDir(id) with --strip-components=1 (sherpa-onnx
// archives carry a top-level directory, and the expected files must land
// directly in packDir(id)). The download is verified before unpacking: the
// response must be 200 OK, the server-reported Content-Length must match
// what we received, and a pinned pack.sha256 is checksummed incrementally
// as the stream is read (no second read of the .part file, no whole-tarball
// buffer in memory). After unpacking, the result is checked with
// verifyPack so a weird layout fails loudly instead of installing a broken
// pack. A failed or cancelled download leaves nothing behind: the .part
// file is always removed, and the pack directory too when the unpack step
// failed after creating it — tar is killed and reaped first.
export const download = async (pack, onProgress = null, cancellable = null) => {
    const dir = packDir(pack.id)
    const part = Gio.File.new_for_path(`${dir}.part`)
    const packDirFile = Gio.File.new_for_path(dir)
    // never delete a pack directory that existed before this download
    const preexisting = packDirFile.query_exists(null)
    try {
        part.get_parent().make_directory_with_parents(null)
    } catch (error) {
        if (error.code !== Gio.IOErrorEnum.EXISTS) throw error
    }
    let out = null
    let unpack = null
    let unpacking = false
    let body = null
    try {
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
        const sum = pack.sha256
            ? new GLib.Checksum(GLib.ChecksumType.SHA256) : null
        let received = 0
        let bytes
        while ((bytes = await gioAsync(body, 'read_bytes_async',
            'read_bytes_finish', SIZE_CHUNK, GLib.PRIORITY_DEFAULT,
            cancellable)).get_size() > 0) {
            await gioAsync(out, 'write_bytes_async', 'write_bytes_finish',
                bytes, GLib.PRIORITY_DEFAULT, cancellable)
            sum?.update(bytes.get_data())
            received += bytes.get_size()
            if (onProgress && total > 0)
                onProgress(Math.min(received / total, 1))
        }
        if (total > 0 && received !== total)
            throw new Error(`size mismatch for ${pack.id}: ` +
                `got ${received} of ${total} bytes`)
        await out.close(null)
        out = null
        if (sum) {
            const digest = sum.get_string()
            if (digest.toLowerCase() !== pack.sha256.toLowerCase())
                throw new Error(`checksum mismatch for ${pack.id}: ` +
                    `got ${digest}, expected ${pack.sha256}`)
        }
        try {
            packDirFile.make_directory_with_parents(null)
        } catch (error) {
            if (error.code !== Gio.IOErrorEnum.EXISTS) throw error
        }
        unpacking = true
        unpack = Gio.Subprocess.new(
            ['tar', '-xjf', part.get_path(), '--strip-components=1',
                '-C', dir],
            Gio.SubprocessFlags.STDOUT_SILENCE |
            Gio.SubprocessFlags.STDERR_SILENCE)
        await gioAsync(unpack, 'wait_check_async', 'wait_check_finish',
            cancellable)
        // a weird layout must fail loudly here, not install a broken pack
        if (!verifyPack(pack))
            throw new Error(`unpacked ${pack.id} is missing expected files`)
        unpacking = false
        // success: the .part file is no longer needed
        part.delete(null)
    } catch (error) {
        // a cancelled wait leaves tar running: stop it before deleting the
        // files it may still be extracting
        if (unpack) {
            unpack.force_exit()
            try {
                await gioAsync(unpack, 'wait_async', 'wait_finish', null)
            } catch { /* nothing left to reap */ }
        }
        try { part.delete(null) } catch { /* nothing to remove */ }
        if (unpacking && !preexisting) {
            try {
                deleteFile(packDirFile)
            } catch { /* best effort */ }
        }
        throw error
    } finally {
        try { body?.close(null) } catch { /* ignore */ }
        try { out?.close(null) } catch { /* ignore */ }
    }
}

const deleteFile = file => {
    if (file.query_file_type(Gio.FileQueryInfoFlags.NONE, null)
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
