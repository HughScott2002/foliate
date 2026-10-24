# Dev helpers: run Foliate from source on NixOS.
# See https://github.com/johnfactotum/foliate#run-without-building-or-installing

SCHEMA_DIR := $(CURDIR)/_build/dev-schemas

.PHONY: run shell test

# Run Foliate straight from the source tree (settings persistence needs a
# compiled GSettings schema, which distro builds provide)
run:
	mkdir -p "$(SCHEMA_DIR)"
	nix-shell --run 'glib-compile-schemas --targetdir="$(SCHEMA_DIR)" data && GSETTINGS_SCHEMA_DIR="$(SCHEMA_DIR)" gjs -m src/main.js $(ARGS)'

# Enter the dev shell for manual runs: gjs -m src/main.js
shell:
	nix-shell

test:
	nix-shell --run 'for test in tests/*-test.mjs; do GTK_A11Y=none GSETTINGS_BACKEND=memory gjs -m "$$test" || exit; done'
