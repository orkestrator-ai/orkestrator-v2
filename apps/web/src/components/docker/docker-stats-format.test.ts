import { describe, expect, test } from "bun:test";
import { formatBytes, formatRelativeTime } from "./docker-stats-format";

describe("Docker stats formatting", () => {
  test("formats zero, binary units, fractions, and very large values", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 ** 5)).toBe("1024 TB");
  });

  test("formats future, recent, hourly, and daily timestamps", () => {
    const now = 1_000_000;
    expect(formatRelativeTime(now + 10, now)).toBe("just now");
    expect(formatRelativeTime(now - 59, now)).toBe("just now");
    expect(formatRelativeTime(now - 120, now)).toBe("2m ago");
    expect(formatRelativeTime(now - 7200, now)).toBe("2h ago");
    expect(formatRelativeTime(now - 172800, now)).toBe("2d ago");
  });
});
