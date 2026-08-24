import { describe, expect, test } from "bun:test";

import { assertElectronReadiness } from "./lifecycle.js";

const complete = { authFile: "/tmp/gateway-auth.json", backendPid: 42, browserUrl: "http://x/" };

describe("Electron readiness", () => {
  test("always requires the backend gateway", () => {
    for (const run of [
      { flavor: "development" as const, fixture: false },
      { flavor: "agent-test" as const, fixture: false },
    ]) {
      expect(() => assertElectronReadiness({ ...complete, authFile: undefined }, run)).toThrow(
        /backend gateway/,
      );
      expect(() => assertElectronReadiness({ ...complete, backendPid: undefined }, run)).toThrow(
        /backend gateway/,
      );
    }
  });

  test("a desktop dev run does not require a reported browser URL", () => {
    // `bun run dev` starts the backend with `--desktop-web-client`, which
    // deliberately omits `browserUrl`: the loopback listener is up, but its
    // authoritative public URL belongs to ManagedWebClient and can arrive after
    // readiness. Requiring it here failed every desktop dev run.
    expect(() =>
      assertElectronReadiness(
        { ...complete, browserUrl: undefined },
        { flavor: "development", fixture: false },
      ),
    ).not.toThrow();
  });

  test("agent-test requires it, because a browser suite has to reach the app", () => {
    expect(() =>
      assertElectronReadiness(
        { ...complete, browserUrl: undefined },
        { flavor: "agent-test", fixture: false },
      ),
    ).toThrow(/loopback browser gateway/);
  });

  test("seeding a fixture requires it whatever the flavor", () => {
    // The seed drives the running app over HTTP, so an absent URL would have it
    // request `undefined` rather than fail with something actionable.
    expect(() =>
      assertElectronReadiness(
        { ...complete, browserUrl: undefined },
        { flavor: "development", fixture: true },
      ),
    ).toThrow(/loopback browser gateway/);
  });

  test("accepts a fully populated readiness message in every mode", () => {
    for (const flavor of ["development", "agent-test"] as const) {
      for (const fixture of [false, true]) {
        expect(() => assertElectronReadiness(complete, { flavor, fixture })).not.toThrow();
      }
    }
  });
});
