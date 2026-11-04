import { describe, expect, mock, test } from "bun:test";
import {
  assertPublished,
  pinnedRelease,
  stampRelease,
} from "../../../scripts/pin-install-script.js";

const SCRIPT = '#!/usr/bin/env bash\nPINNED_RELEASE="2.36.1"\nPACKAGE="x"\n';

describe("pinning install.sh", () => {
  test("reads and moves the pin, leaving the rest of the script alone", () => {
    expect(pinnedRelease(SCRIPT)).toBe("2.36.1");
    const stamped = stampRelease(SCRIPT, "2.37.0");
    expect(pinnedRelease(stamped)).toBe("2.37.0");
    expect(stamped).toBe(SCRIPT.replace("2.36.1", "2.37.0"));
  });

  test("re-stamping the current version changes nothing", () => {
    expect(stampRelease(SCRIPT, "2.36.1")).toBe(SCRIPT);
  });

  test("refuses a prerelease, a moving tag and a step backwards", () => {
    expect(() => stampRelease(SCRIPT, "2.37.0-beta")).toThrow("not a Stable release");
    expect(() => stampRelease(SCRIPT, "2.37.0-alpha")).toThrow("not a Stable release");
    expect(() => stampRelease(SCRIPT, "latest")).toThrow("not a Stable release");
    expect(() => stampRelease(SCRIPT, "2.36.0")).toThrow("older than the current pin");
  });

  test("refuses a script with no pin line", () => {
    expect(() => pinnedRelease("#!/usr/bin/env bash\n")).toThrow("no PINNED_RELEASE line");
  });

  test("refuses a version npm does not have", async () => {
    const answer = (status: number) =>
      mock(async () => new Response(null, { status })) as unknown as typeof fetch;
    await expect(assertPublished("2.37.0", answer(200))).resolves.toBeUndefined();
    await expect(assertPublished("2.37.0", answer(404))).rejects.toThrow("not on npm (HTTP 404)");
  });
});
