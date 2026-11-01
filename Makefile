# Dev helpers: run Foliate from source on NixOS.
# See https://github.com/johnfactotum/foliate#run-without-building-or-installing

SCHEMA_DIR := $(CURDIR)/target

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
	FOLIATE_TEST_SCHEMA_XML=data/com.github.johnfactotum.Foliate.gschema.xml \
		nix-shell --run 'sh tests/run-isolated-tests.sh tests/*-test.mjs'
