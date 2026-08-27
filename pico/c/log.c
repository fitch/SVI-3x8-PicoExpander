/**
 * SVI-3x8 PicoExpander
 *
 * Copyright (c) 2026 Markus Rautopuro
 *
 * Works only with Raspberry Pico 2 W.
 */

#include <stdio.h>
#include <stdarg.h>
#include <string.h>
#include "pico/stdlib.h"

#include "log.h"
#include "frame.h"
#include "svi-328-expander-bus.h"
#include "mpack.h"

uint32_t boot_time_us = 0;

void log_message_ts(uint32_t timestamp_us, const char *format, ...) {
    va_list args;
    char msg[128];

    va_start(args, format);
    vsnprintf(msg, sizeof(msg), format, args);
    va_end(args);

    // Encode as MessagePack: {t:"event", c:"log", ts:<timestamp>, msg:<text>}
    uint8_t frame[256];
    mpack_writer_t w;
    mpack_writer_init(&w, (char *)frame, sizeof(frame));

    mpack_start_map(&w, 4);
    mpack_write_cstr(&w, "t");
    mpack_write_cstr(&w, "event");
    mpack_write_cstr(&w, "c");
    mpack_write_cstr(&w, "log");
    mpack_write_cstr(&w, "ts");
    mpack_write_u32(&w, timestamp_us);
    mpack_write_cstr(&w, "msg");
    mpack_write_cstr(&w, msg);
    mpack_finish_map(&w);

    size_t used = mpack_writer_buffer_used(&w);
    if (mpack_writer_destroy(&w) == mpack_ok && used > 0) {
        frame_queue_send(FRAME_PRI_NORMAL, frame, used);
    }

    // Always print to serial for debug
    printf("[%010lu] %s\n", (unsigned long)timestamp_us, msg);
}