import { describe } from "bun:test";
import { PAST_DEFAULT_CLOSE_MS, idlePostTest } from "./gateway-keep-alive-live-support.js";

describe("gateway connections idle past the default keep-alive close", () => {
  idlePostTest(PAST_DEFAULT_CLOSE_MS, PAST_DEFAULT_CLOSE_MS + 15_000);
});
