import { describe, expect, test } from "bun:test";
import {
  APP_SLUG,
  LINUX_DESKTOP_ENTRY_FILENAME,
  userDataDirectoryName,
} from "../../../apps/desktop/electron/app-constants";

describe("userDataDirectoryName", () => {
  test("keeps the Linux desktop filename aligned with the application slug", () => {
    expect(LINUX_DESKTOP_ENTRY_FILENAME).toBe(`${APP_SLUG}.desktop`);
  });

  test("keeps the packaged app on the shared production data directory", () => {
    expect(userDataDirectoryName(false)).toBe(APP_SLUG);
  });

  test("isolates bun run dev from a packaged install", () => {
    expect(userDataDirectoryName(true)).toBe(`${APP_SLUG}-dev`);
    expect(userDataDirectoryName(true)).not.toBe(userDataDirectoryName(false));
  });
});
