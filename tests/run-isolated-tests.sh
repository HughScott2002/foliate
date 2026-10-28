#!/bin/sh
# Run each GJS test in its own fresh, canonical-checked XDG tree.
#
# In-process GLib.setenv is not enough: GLib caches user directories when a
# process starts (module bytecode cache, GSettings, etc.), and an existing
# smoke test used to repoint XDG_DATA_HOME back at the real user data. So the
# roots are created and exported here, before each gjs process starts.
#
# FOLIATE_VOICE_TEST_SMOKE stays unset: the real-model smoke in
# tests/local-tts-test.mjs is opt-in and never runs in the normal suite.
set -eu

if [ "$#" -eq 0 ]; then
    echo "usage: $0 <test-file>..." >&2
    exit 2
fi

# Bounded cleanup of an already canonical-checked owned root. GTK/WebKit may
# still be flushing Mesa's shader cache when its process exits; retry once
# before reporting. A persistent failure is a visible warning, never the
# suite's exit status, and only the owned root is touched.
cleanup_root() {
    rm -rf "$1" 2>/dev/null && return 0
    sleep 1
    rm -rf "$1" 2>/dev/null && return 0
    echo "warning: could not fully remove owned test root: $1" >&2
    return 0
}

for test in "$@"; do
    root=$(mktemp -d "${TMPDIR:-/tmp}/foliate-test-XXXXXX")
    # canonical check: never let a writable test tree resolve into the real
    # home (the real voice models live under ~/.local/share/foliate)
    root=$(realpath -m "$root")
    home=$(realpath -m "${HOME:-/}")
    case "$root" in
        "$home"|"$home"/*)
            echo "refusing unsafe test root: $root" >&2
            rm -rf "$root"
            exit 1
            ;;
    esac
    mkdir -p "$root/data" "$root/cache" "$root/config"
    # FOLIATE_TEST_SCHEMA_XML points at a gschema.xml to compile into an owned
    # schema dir: the memory backend stores values, GSETTINGS_SCHEMA_DIR makes
    # the app-defined keys (and ranges) visible to the test process.
    if [ -n "${FOLIATE_TEST_SCHEMA_XML:-}" ]; then
        schemas="$root/schemas"
        mkdir -p "$schemas"
        schema_file=$(basename "$FOLIATE_TEST_SCHEMA_XML")
        case "$schema_file" in
            *.gschema.xml) ;;
            *) schema_file=com.github.johnfactotum.Foliate.gschema.xml ;;
        esac
        cp "$FOLIATE_TEST_SCHEMA_XML" "$schemas/$schema_file"
        glib-compile-schemas "$schemas"
        export GSETTINGS_SCHEMA_DIR="$schemas"
    fi
    # Mesa's disk shader cache flushes asynchronously at GTK/WebKit teardown;
    # disabling it for fixture processes removes the cleanup race entirely.
    # Both names are honored by Mesa 25.2.6's libgallium.
    if XDG_DATA_HOME="$root/data" \
         XDG_CACHE_HOME="$root/cache" \
         XDG_CONFIG_HOME="$root/config" \
         GSETTINGS_BACKEND=memory \
         GTK_A11Y=none \
         FOLIATE_VOICE_TEST_SMOKE="${FOLIATE_VOICE_TEST_SMOKE:-0}" \
         MESA_SHADER_CACHE_DISABLE=1 \
         MESA_GLSL_CACHE_DISABLE=true \
         gjs -m "$test"; then
        test_rc=0
    else
        test_rc=$?
    fi
    cleanup_root "$root"
    [ "$test_rc" -eq 0 ] || exit "$test_rc"
done
