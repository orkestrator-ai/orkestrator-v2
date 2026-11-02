import { defineLogAreas } from "./define.js";

export const GATEWAY_LOG_AREAS = defineLogAreas({
  gateway: {
    description: "The gateway other devices, browsers and the desktop connect through.",
    events: {
      "remote.start-failed": "The desktop could not start the remote gateway.",
      "remote.stop-failed": "The desktop could not stop the remote gateway cleanly.",
      disabled: "The gateway is disabled by its environment variable.",
      "tailscale.no-address": "No Tailscale address was found, so the gateway did not start.",
      "tailscale.no-address-fallback":
        "No Tailscale address was found, so the gateway binds its fallback address.",
      "control.listening": "The backend control listener is up.",
      "browser.listening": "The browser listener is up.",
      "browser.unavailable": "The browser listener could not start and nothing else is listening.",
      "browser.unavailable-degraded":
        "The browser listener could not start; another listener remains.",
      "loopback.listening": "The loopback client listener is up.",
      "loopback.unavailable": "The loopback client listener could not start.",
      "auth-token.stored": "The gateway token's file was written. The path only, never the token.",
      "auth-token.persist-failed": "The gateway token could not be saved.",
      "port.fallback": "The preferred port was taken, so a nearby one is used.",
      "port.fallback-distant":
        "The preferred port and those nearby were taken, so another is used.",
      "request.failed": "A gateway request failed. Throttled: repeats are counted, not written.",
      "websocket.upgrade-failed": "A WebSocket upgrade failed.",
      "events.client-dropped":
        "An event-stream client buffered too much and was dropped; it reconnects and refetches.",
      "proxy.client-disconnected": "A proxy client went away, so its upstream request was aborted.",
      "throttle.suppressed":
        "Repeats of the throttled `site` were counted over a window, not written.",
      "throttle.recovered": "The throttled `site` succeeded again, so its fault has cleared.",
      "throttle.evicted":
        "The tracked-key limit dropped the `site`, so no recovered line follows unless it fails again.",
    },
  },
  "gateway.terminal": {
    description: "The gateway's terminal WebSocket.",
    events: {
      "upgrade-rejected": "A terminal WebSocket upgrade was refused.",
      "socket-error": "A terminal WebSocket reported an error.",
      "subscription-failed": "A terminal subscription failed.",
      "operation-failed":
        "A terminal operation failed. Fixed text: the operation can hold terminal input.",
    },
  },
  "gateway.tailscale": {
    description: "Tailscale Serve for desktop web access and a standalone backend.",
    events: {
      "web-access.disable-failed": "Desktop web access could not be turned off.",
      "web-access.enable-failed": "Desktop web access could not be turned on.",
      "web-access.cleanup-failed": "Cleaning up after a failed enable also failed.",
      "web-access.reset-failed": "Desktop web access could not be reset.",
      "startup.init-failed": "Desktop web access could not be initialized at startup.",
      available: "Tailscale Serve is publishing the gateway.",
    },
  },
});
