# Makefile for SVI-3x8-PicoExpander
# Wraps CMake/Ninja build commands

VERSION := $(shell cat pico/VERSION)
BUILD_DIR = pico/build
UF2_FILE = $(BUILD_DIR)/svi-3x8-picoexpander.uf2
RELEASE_DIR = release
RELEASE_FILE = $(RELEASE_DIR)/svi-3x8-picoexpander-$(VERSION).uf2

.PHONY: main release clean configure

main:
	@echo "SVI-3x8 PicoExpander $(VERSION) Pico firmware makefile"
	@echo
	@echo "Available targets:"
	@echo "  release   - Clean and build the project (creates $(UF2_FILE))"
	@echo "  clean     - Remove build artifacts"
	@echo "  configure - Reconfigure CMake"

.DEFAULT_GOAL := main

release:
	cmake --build $(BUILD_DIR) --clean-first
	@mkdir -p $(RELEASE_DIR)
	cp $(UF2_FILE) $(RELEASE_FILE)
	@echo "Release created: $(RELEASE_FILE)"

clean:
	cmake --build $(BUILD_DIR) --target clean

configure:
	cmake -B $(BUILD_DIR)
