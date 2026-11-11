import { describe, expect, test } from "bun:test";
import {
  BRIDGE_RESTART_PROVIDERS,
  BridgeRestartCounter,
  bridgeProviderOfKey,
} from "./bridge-restarts.js";
import { LOCAL_SERVER_KINDS } from "./local-server-runtime.js";
import { openCode2ServerKey } from "./opencode2/host-server-state.js";

describe("bridge restart counter", () => {
  test("an idle backend has nothing to report", () => {
    expect(new BridgeRestartCounter().snapshot()).toEqual({});
  });

  test("host starts and unrequested exits count by the key's provider", () => {
    const counter = new BridgeRestartCounter();
    counter.localStarted("claude:env-1");
    counter.localStarted("claude:env-2");
    counter.localExited("claude:env-1", false);
    counter.localExited("claude:env-2", true);
    counter.localStarted(openCode2ServerKey("env-3"));
    expect(counter.snapshot()).toEqual({
      claude: { localStarts: 2, localUnrequestedExits: 1, containerLaunches: 0 },
      opencode: { localStarts: 1, localUnrequestedExits: 0, containerLaunches: 0 },
    });
  });

  test("container launches count by provider", () => {
    const counter = new BridgeRestartCounter();
    counter.containerLaunched("codex");
    counter.containerLaunched("codex");
    expect(counter.snapshot()).toEqual({
      codex: { localStarts: 0, localUnrequestedExits: 0, containerLaunches: 2 },
    });
  });

  test("a name outside the provider vocabulary is not counted, so the table stays bounded", () => {
    const counter = new BridgeRestartCounter();
    counter.localStarted("not-a-provider:env-1");
    counter.localStarted("no-separator");
    counter.localStarted(":env-1");
    counter.containerLaunched("/home/someone/secret");
    expect(counter.snapshot()).toEqual({});
    expect(bridgeProviderOfKey("grok:env-1")).toBe("grok");
    expect(bridgeProviderOfKey("grok")).toBeNull();
    // The OpenCode server is the environment's `opencode` local server.
    expect(bridgeProviderOfKey(openCode2ServerKey("env-1"))).toBe("opencode");
    expect(bridgeProviderOfKey("opencode2:env-1")).toBeNull();
  });

  test("a snapshot is a copy", () => {
    const counter = new BridgeRestartCounter();
    counter.containerLaunched("pi");
    const snapshot = counter.snapshot();
    counter.containerLaunched("pi");
    expect(snapshot.pi?.containerLaunches).toBe(1);
  });

  test("every local server kind is a counted provider", () => {
    for (const kind of LOCAL_SERVER_KINDS) {
      expect(BRIDGE_RESTART_PROVIDERS).toContain(kind);
    }
  });
});
