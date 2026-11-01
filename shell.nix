{ pkgs ? import <nixpkgs> {} }:
let
  # Upstream runtime, not a voice model. Keep this version aligned with the
  # CLI flags in src/local-tts.js. Nix fixes the upstream ELF loader/RPATH.
  sherpa = pkgs.stdenvNoCC.mkDerivation {
    pname = "foliate-sherpa-onnx";
    # 2.0 removes the built-in Piper/eSpeak frontend required by these packs.
    version = "1.13.8";
    src = pkgs.fetchurl {
      url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v1.13.8/sherpa-onnx-v1.13.8-linux-x64-shared.tar.bz2";
      sha256 = "c0bdb7907d3a74bba1d55d22bf4d9fa75586cf1530614ebe88a27b9118e015c4";
    };
    nativeBuildInputs = [ pkgs.autoPatchelfHook ];
    buildInputs = [ pkgs.stdenv.cc.cc.lib pkgs.alsa-lib ];
    installPhase = ''
      mkdir -p $out/bin $out/lib
      cp bin/sherpa-onnx-offline-tts $out/bin/
      cp -a lib/. $out/lib/
    '';
  };
in pkgs.mkShell {
  packages = with pkgs; [
    sherpa gjs gobject-introspection gtk4 libadwaita webkitgtk_6_0
    libsoup_3 tinysparql glib python3 gnutar bzip2
    gst_all_1.gstreamer gst_all_1.gst-plugins-base
    gst_all_1.gst-plugins-good gst_all_1.gst-plugins-bad
  ];
}
