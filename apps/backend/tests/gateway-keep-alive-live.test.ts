import { describe } from "bun:test";
import { NEAR_SERVE_IDLE_CLOSE_MS, idlePostTest } from "./gateway-keep-alive-live-support.js";

describe("gateway connections idle past the default keep-alive close", () => {
  idlePostTest(NEAR_SERVE_IDLE_CLOSE_MS, NEAR_SERVE_IDLE_CLOSE_MS + 15_000);
});
