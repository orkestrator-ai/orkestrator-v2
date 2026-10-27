import { expect, test } from "bun:test";
import { isolateXdgEnvironment, XDG_KEYS } from "./xdg-fixture.js";

for (const defined of [true, false]) {
  test(`XDG fixture clears all four overrides and restores ${defined ? "defined" : "absent"} values`, () => {
    const env: NodeJS.ProcessEnv = { HOME: "/fixture/home", OTHER: "preserved" };
    if (defined) for (const key of XDG_KEYS) env[key] = `/host/${key}`;
    const original = { ...env };
    const restore = isolateXdgEnvironment(env);
    for (const key of XDG_KEYS) expect(env[key]).toBeUndefined();
    expect(env.HOME).toBe(original.HOME);
    for (const key of XDG_KEYS) env[key] = "changed during test";
    restore();
    expect(env).toEqual(original);
  });
}
