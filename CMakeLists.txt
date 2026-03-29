cmake_minimum_required(VERSION 3.13)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_BUILD_TYPE Release)

# == DO NOT EDIT THE FOLLOWING LINES for the Raspberry Pi Pico VS Code Extension to work ==
if(WIN32)
    set(USERHOME $ENV{USERPROFILE})
else()
    set(USERHOME $ENV{HOME})
endif()
set(sdkVersion 2.2.0)
set(toolchainVersion 14_2_Rel1)
set(picotoolVersion 2.2.0)
set(picoVscode ${USERHOME}/.pico-sdk/cmake/pico-vscode.cmake)
if (EXISTS ${picoVscode})
    include(${picoVscode})
endif()
# ====================================================================================
set(PICO_BOARD pico2_w CACHE STRING "Board type")

include(pico_sdk_import.cmake)

project(svi-3x8-picoexpander C CXX ASM)

pico_sdk_init()

# --- Generate launcher_bootsector.h from launcher_bootsector.asm ---
find_program(SJASMPLUS sjasmplus REQUIRED)

set(LAUNCHER_BOOTSECTOR_ASM ${CMAKE_CURRENT_LIST_DIR}/pico/asm/launcher_bootsector.asm)
set(LAUNCHER_BOOTSECTOR_ROM ${CMAKE_CURRENT_BINARY_DIR}/launcher_bootsector.rom)
set(LAUNCHER_BOOTSECTOR_H ${CMAKE_CURRENT_BINARY_DIR}/launcher_bootsector.h)

add_custom_command(
    OUTPUT ${LAUNCHER_BOOTSECTOR_ROM}
    COMMAND ${SJASMPLUS} --nologo
        -DUSE_BANK4
        --raw=${LAUNCHER_BOOTSECTOR_ROM}
        ${LAUNCHER_BOOTSECTOR_ASM}
    DEPENDS ${LAUNCHER_BOOTSECTOR_ASM}
    COMMENT "Assembling launcher_bootsector.asm -> launcher_bootsector.rom"
    VERBATIM
)

add_custom_command(
    OUTPUT ${LAUNCHER_BOOTSECTOR_H}
    COMMAND ${CMAKE_COMMAND} -E echo "Generating launcher_bootsector.h..."
    COMMAND sh -c "xxd -n LAUNCHER_BOOTSECTOR -i ${LAUNCHER_BOOTSECTOR_ROM} | \
        sed -e 's/^unsigned char/static const uint8_t __attribute__((section(\".time_critical.LAUNCHER_BOOTSECTOR\")))/' \
            -e 's/^unsigned int/static const uint32_t/' > ${LAUNCHER_BOOTSECTOR_H}"
    DEPENDS ${LAUNCHER_BOOTSECTOR_ROM}
    COMMENT "Converting launcher_bootsector.rom -> launcher_bootsector.h"
    VERBATIM
)

add_custom_target(generate_launcher_bootsector DEPENDS ${LAUNCHER_BOOTSECTOR_H})

# --- Generate injectboot.h from injectboot.asm ---
set(INJECTBOOT_ASM ${CMAKE_CURRENT_LIST_DIR}/pico/asm/injectboot.asm)
set(INJECTBOOT_ROM ${CMAKE_CURRENT_BINARY_DIR}/injectboot.rom)
set(INJECTBOOT_H ${CMAKE_CURRENT_BINARY_DIR}/injectboot.h)

add_custom_command(
    OUTPUT ${INJECTBOOT_ROM}
    COMMAND ${SJASMPLUS} --nologo
        --raw=${INJECTBOOT_ROM}
        ${INJECTBOOT_ASM}
    DEPENDS ${INJECTBOOT_ASM}
    COMMENT "Assembling injectboot.asm -> injectboot.rom"
    VERBATIM
)

add_custom_command(
    OUTPUT ${INJECTBOOT_H}
    COMMAND ${CMAKE_COMMAND} -E echo "Generating injectboot.h..."
    COMMAND sh -c "xxd -n INJECTBOOT -i ${INJECTBOOT_ROM} | \
        sed -e 's/^unsigned char/static const uint8_t __attribute__((section(\".time_critical.INJECTBOOT\")))/' \
            -e 's/^unsigned int/static const uint32_t/' > ${INJECTBOOT_H}"
    DEPENDS ${INJECTBOOT_ROM}
    COMMENT "Converting injectboot.rom -> injectboot.h"
    VERBATIM
)

add_custom_target(generate_injectboot DEPENDS ${INJECTBOOT_H})

# --- Generate prepare.h from prepare.asm ---
set(PREPARE_ASM ${CMAKE_CURRENT_LIST_DIR}/pico/asm/prepare.asm)
set(PREPARE_ROM ${CMAKE_CURRENT_BINARY_DIR}/prepare.rom)
set(PREPARE_H ${CMAKE_CURRENT_BINARY_DIR}/prepare.h)

add_custom_command(
    OUTPUT ${PREPARE_ROM}
    COMMAND ${SJASMPLUS} --nologo
        --raw=${PREPARE_ROM}
        ${PREPARE_ASM}
    DEPENDS ${PREPARE_ASM}
    COMMENT "Assembling prepare.asm -> prepare.rom"
    VERBATIM
)

add_custom_command(
    OUTPUT ${PREPARE_H}
    COMMAND ${CMAKE_COMMAND} -E echo "Generating prepare.h..."
    COMMAND sh -c "xxd -n PREPARE -i ${PREPARE_ROM} | \
        sed -e 's/^unsigned char/static const uint8_t __attribute__((section(\".time_critical.PREPARE\")))/' \
            -e 's/^unsigned int/static const uint32_t/' > ${PREPARE_H}"
    DEPENDS ${PREPARE_ROM}
    COMMENT "Converting prepare.rom -> prepare.h"
    VERBATIM
)

add_custom_target(generate_prepare DEPENDS ${PREPARE_H})

add_executable(svi-3x8-picoexpander
    pico/c/main.c
    pico/c/svi-328-expander-bus.c
    pico/c/media_control.c
    pico/c/log.c
    pico/c/wifi.c
    )

# Ensure headers are generated before compiling
add_dependencies(svi-3x8-picoexpander generate_launcher_bootsector generate_injectboot generate_prepare)

target_include_directories(svi-3x8-picoexpander PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}/pico
    ${CMAKE_CURRENT_LIST_DIR}/pico/c # lwipopts.h
    ${CMAKE_CURRENT_BINARY_DIR}
    )

target_link_libraries(svi-3x8-picoexpander
    pico_stdlib
    pico_multicore
    pico_cyw43_arch_lwip_poll
    pico_lwip
)

string(TIMESTAMP BUILD_DATE "%Y-%m-%d")
file(READ ${CMAKE_CURRENT_LIST_DIR}/pico/VERSION VERSION)
string(STRIP ${VERSION} VERSION)
target_compile_definitions(svi-3x8-picoexpander PRIVATE
    BUILD_DATE="${BUILD_DATE}"
    VERSION="${VERSION}"
    PICO_EMBED_XIP_SETUP=1
    PICO_FLASH_ASSUME_CORE1_SAFE=1
    CYW43_PIO_CLOCK_DIV_DYNAMIC=1)

target_compile_definitions(bs2_default PRIVATE
    PICO_FLASH_SPI_RXDELAY=4
    PICO_FLASH_SPI_CLKDIV=4
    PICO_FLASH_ASSUME_CORE1_SAFE=1)

pico_set_linker_script(svi-3x8-picoexpander ${CMAKE_CURRENT_LIST_DIR}/pico/config/memmap_rp2350.ld)

pico_enable_stdio_usb(svi-3x8-picoexpander 1)
pico_enable_stdio_uart(svi-3x8-picoexpander 0)

pico_add_extra_outputs(svi-3x8-picoexpander)

target_link_options(svi-3x8-picoexpander PRIVATE -Wl,--strip-debug,-Map=firmware.map)

set_source_files_properties(pico/c/svi-328-expander-bus.c PROPERTIES COMPILE_FLAGS "-fno-builtin")
