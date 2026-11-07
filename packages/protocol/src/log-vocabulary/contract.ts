import { defineLogAreas } from "./define.js";

export const CONTRACT_LOG_AREAS = defineLogAreas({
  contract: {
    description: "Versioned command contracts: domain ranges a peer's hello advertises.",
    events: {
      "hello.domains-malformed":
        "A peer's hello carried a `domains` field outside its bounds, so the peer is treated as pre-contract. `reason` only, never names or values.",
    },
  },
});
