/**
 * SVI-3x8 PicoExpander
 * 
 * Copyright (c) 2026 Markus Rautopuro
 * 
 * Works only with Raspberry Pico 2 W.
 */

#include "pico/cyw43_arch.h"

#include "wifi.h"
#include "log.h"
#include "svi-328-expander-bus.h"

extern uint8_t pico_unique_id_chars[2];

// ---------------------------------------------------------------------------
// Wi-Fi init and scan
// ---------------------------------------------------------------------------

static int found_ssid_auth_mode = -1;
static const char *target_ssid = NULL;
static volatile bool ssid_found = false;

static int scan_callback(void *env, const cyw43_ev_scan_result_t *result) {
    (void)env;
    if (result && target_ssid && !ssid_found) {
        if (result->ssid_len > 0 && strcmp((const char *)result->ssid, target_ssid) == 0) {
            found_ssid_auth_mode = result->auth_mode;
            ssid_found = true;
            log_message("Found target SSID '%s' (auth_mode=%d, rssi=%d)", result->ssid, result->auth_mode, result->rssi);
        }
    }
    return 0;
}

void wifi_init(void) {
    if (cyw43_arch_init() != PICO_OK) {
        pico_state = PICO_STATE_WIFI_ERROR;
        // Blink 5 times to indicate error
        while (true) {
            for (int i = 0; i < 5; i++) {
                pico_set_led(true);
                sleep_ms(600);
                pico_set_led(false);
                sleep_ms(500);
            }
            sleep_ms(2000);
        }
    }
}

int wifi_scan(const char *ssid_to_find) {
    cyw43_wifi_scan_options_t scan_options = {0};

    target_ssid = ssid_to_find;
    ssid_found = false;
    found_ssid_auth_mode = -1;

    for (int round = 0; round < 3 && !ssid_found; round++) {
        log_message("Starting Wi-Fi scan round %d for SSID '%s'...", round + 1, ssid_to_find);

        int err = cyw43_wifi_scan(&cyw43_state, &scan_options, NULL, scan_callback);
        if (err) {
            log_message("Wi-Fi scan failed to start: %d", err);
            continue;
        }

        absolute_time_t timeout = make_timeout_time_ms(10000);
        while (cyw43_wifi_scan_active(&cyw43_state) && !time_reached(timeout) && !ssid_found) {
            sleep_ms(10);
        }

        if (!ssid_found && cyw43_wifi_scan_active(&cyw43_state)) {
            log_message("Wi-Fi scan round %d timed out.", round + 1);
        }
    }

    if (!ssid_found) {
        log_message("Target SSID '%s' not found after scanning.", ssid_to_find);
    }

    target_ssid = NULL;
    return found_ssid_auth_mode;
}

#define UDP_BROADCAST_PORT 4243

void pico_set_led(bool led_on) {
    cyw43_arch_gpio_put(CYW43_WL_GPIO_LED_PIN, led_on);
}

void wait_for_ip() {
    struct netif *netif = &cyw43_state.netif[0];
    log_message("Waiting for IP address...");
    while (netif->ip_addr.addr == 0) {
        sleep_ms(100);
    }
    log_message("IP Address obtained: %s", ipaddr_ntoa(&netif->ip_addr));
}

void send_udp_broadcast() {
    struct netif *netif = &cyw43_state.netif[CYW43_ITF_STA];

    struct udp_pcb *udp = udp_new();
    if (!udp) {
        log_message("Failed to create UDP PCB");
        return;
    }

    ip_addr_t broadcast_addr = netif->ip_addr;
    ip4_addr_set_u32(&broadcast_addr, ip4_addr_get_u32(&broadcast_addr) | ~ip4_addr_get_u32(&netif->netmask));

    char msg[64];
    snprintf(msg, sizeof(msg), "SVI-3x8 PicoExpander hello! %c%c", pico_unique_id_chars[0], pico_unique_id_chars[1]);

    struct pbuf *pb = pbuf_alloc(PBUF_TRANSPORT, strlen(msg), PBUF_RAM);
    memcpy(pb->payload, msg, strlen(msg));

    udp_sendto(udp, pb, &broadcast_addr, UDP_BROADCAST_PORT);

    pbuf_free(pb);
    udp_remove(udp);
}
