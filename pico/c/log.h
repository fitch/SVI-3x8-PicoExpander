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
extern size_t log_index;
extern char log_buffer[];

struct tcp_pcb;

typedef void (*log_completion_callback_t)(struct tcp_pcb *pcb);

void flush_logs(struct tcp_pcb *pcb, log_completion_callback_t on_complete);
void flush_text_log(struct tcp_pcb *pcb, log_completion_callback_t on_complete);
void flush_hardware_log(struct tcp_pcb *pcb, log_completion_callback_t on_complete);

#endif // LOG_H