import GLib from 'gi://GLib'
import Gio from 'gi://Gio'

// Voice packs for local neural TTS. Each entry describes a downloadable
// model tarball (sherpa-onnx) unpacked under the app's data dir.

// Data dir resolution: mirrors pkg.datadir in main.js (which is only set
// when running the full app), using 'foliate' as the directory name so the
// module works standalone. Keep in sync with main.js.
const voicesDir = () =>
    GLib.build_filenamev([GLib.get_user_data_dir(), 'foliate', 'voices'])

// SHA-256 pins are null placeholders: checksum verification of the
// downloads is a separate later pass.
export const getPacks = () => [{
    id: 'kokoro',
    label: 'Kokoro (multi-language)',
    sizeMB: 141,
    languages: ['en', 'zh'],
    sid: 23,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2',
    sha256: null,
    sample: 'Hello! This is a sample of the Kokoro voice.',
    expectedFiles: ['model.onnx', 'voices.bin', 'tokens.txt'],
}, {
    id: 'supertonic',
    label: 'Supertonic 3 (31 languages)',
    sizeMB: 123,
    languages: ['en'],
    numLanguages: 31,
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
    sizeMB: 79,
    languages: ['en'],
    sid: 0,
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-en_US-amy-low.tar.bz2',
    sha256: null,
    sample: 'Hello! This is a sample of the Piper voice.',
    expectedFiles: ['en_US-amy-low.onnx', 'tokens.txt'],
}]

export const packDir = id => GLib.build_filenamev([voicesDir(), id])

export const getInstalledPacks = () => getPacks().filter(pack =>
    GLib.file_test(packDir(pack.id), GLib.FileTest.IS_DIR))

// A pack is verified if every expected model file is present as a regular
// file inside the unpacked pack directory.
export const verifyPack = pack => {
    const dir = packDir(pack.id)
    if (!GLib.file_test(dir, GLib.FileTest.IS_DIR)) return false
    return pack.expectedFiles.every(name => GLib.file_test(
        GLib.build_filenamev([dir, name]), GLib.FileTest.IS_REGULAR))
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
        let info
        while ((info = children.next_file(null)) != null)
            deleteFile(file.get_child(info.get_name()))
        children.close(null)
    }
    return file.delete(null)
}

export const deletePack = id => {
    const file = Gio.File.new_for_path(packDir(id))
    return file.query_exists(null) && deleteFile(file)
}
