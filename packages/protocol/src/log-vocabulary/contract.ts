import { defineLogAreas } from "./define.js";

export const CONTRACT_LOG_AREAS = defineLogAreas({
  contract: {
    description:
      "Versioned command and event contracts: domain ranges a peer's hello advertises, typed backend events.",
    events: {
      "hello.domains-malformed":
        "A peer's hello carried a `domains` field outside its bounds, so the peer is treated as pre-contract. `reason` only, never names or values.",
      "listen.payload-invalid":
        "A client dropped a received event whose payload did not decode against its contract definition. `event` (the name, or a family's prefix) only, never payload values.",
      "event.invalid":
        "Development only: the backend emitted an event whose payload, key or definition failed its contract check; it was still delivered. `event` (the name, or a family's prefix) and `error` (`payload` or the check that failed), never payload values.",
    },
  },
});
