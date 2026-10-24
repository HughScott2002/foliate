import GLib from 'gi://GLib'
import Gio from 'gi://Gio'

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

// Stub: streaming download to `<packDir>.part` with Gio.File copy_async,
// progress callbacks, and atomic rename is implemented in Task 2.
export const download = async () => {
    throw new Error('download is not implemented in Task 1')
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
