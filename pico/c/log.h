/**
 * SVI-3x8 PicoExpander
 *
 * Copyright (c) 2026 Markus Rautopuro
 *
 * Works only with Raspberry Pico 2 W.
 */

#ifndef LOG_H
#define LOG_H

void log_message_ts(uint32_t timestamp_us, const char *format, ...);
#ifndef log_message
#define log_message(format, ...) log_message_ts(HW_TIMESTAMP - boot_time_us, format, ##__VA_ARGS__)
#endif

extern uint32_t boot_time_us;

#endif // LOG_H
