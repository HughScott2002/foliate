# Dev helpers: run Foliate from source on NixOS.
# See https://github.com/johnfactotum/foliate#run-without-building-or-installing

NIX_PKGS := gjs gobject-introspection libsoup_3 python3 gtk4 libadwaita webkitgtk_6_0 glib

.PHONY: run shell

# Run Foliate straight from the source tree (settings persistence needs a
# compiled GSettings schema, which distro builds provide)
run:
	git submodule update --init
	nix-shell -p $(NIX_PKGS) --run 'GSETTINGS_SCHEMA_DIR=data gjs -m src/main.js'

# Enter the dev shell for manual runs: gjs -m src/main.js
shell:
	nix-shell -p $(NIX_PKGS)
