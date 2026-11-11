import { describe, expect, test } from "bun:test";

import {
  BASE64_FILE_READ_COMMANDS,
  BASE64_FILE_READ_SIZE_BUCKETS,
  Base64FileReadSizeHistogram,
} from "./gateway-file-read-sizes.js";

const KIB = 1024;
const MIB = 1024 * KIB;

describe("Base64FileReadSizeHistogram", () => {
  test("starts with every reader at zero, so the shape never depends on use", () => {
    const snapshot = new Base64FileReadSizeHistogram().snapshot();
    expect(Object.keys(snapshot).sort()).toEqual([...BASE64_FILE_READ_COMMANDS].sort());
    for (const command of BASE64_FILE_READ_COMMANDS) {
      expect(snapshot[command].count).toBe(0);
      expect(snapshot[command].maxBytes).toBe(0);
      expect(Object.keys(snapshot[command].buckets)).toEqual([
        ...BASE64_FILE_READ_SIZE_BUCKETS.map((bucket) => bucket.label),
        "over16MiB",
      ]);
      expect(Object.values(snapshot[command].buckets).every((count) => count === 0)).toBe(true);
    }
  });

  test("puts a size on a bound in that bucket and one byte more in the next", () => {
    const histogram = new Base64FileReadSizeHistogram();
    for (const bytes of [0, 64 * KIB, 64 * KIB + 1, MIB, 4 * MIB + 1, 16 * MIB, 16 * MIB + 1]) {
      histogram.record("read_file_base64", bytes, true);
    }
    const sizes = histogram.snapshot().read_file_base64;
    expect(sizes.count).toBe(7);
    expect(sizes.maxBytes).toBe(16 * MIB + 1);
    expect(sizes.buckets).toEqual({
      upTo64KiB: 2,
      upTo256KiB: 1,
      upTo1MiB: 1,
      upTo4MiB: 0,
      upTo8MiB: 1,
      upTo16MiB: 1,
      over16MiB: 1,
    });
  });

  test("keeps each reader separate and ignores failures and every other command", () => {
    const histogram = new Base64FileReadSizeHistogram();
    histogram.record("read_environment_file_base64", 2 * MIB, true);
    histogram.record("read_container_file_base64", 300 * KIB, true);
    histogram.record("read_container_file_base64", 9 * MIB, false);
    histogram.record("read_file", 9 * MIB, true);
    histogram.record("__unknown__", 9 * MIB, true);

    const snapshot = histogram.snapshot();
    expect(snapshot.read_file_base64.count).toBe(0);
    expect(snapshot.read_environment_file_base64).toMatchObject({
      count: 1,
      maxBytes: 2 * MIB,
      buckets: { upTo4MiB: 1 },
    });
    expect(snapshot.read_container_file_base64).toMatchObject({
      count: 1,
      maxBytes: 300 * KIB,
      buckets: { upTo1MiB: 1, upTo16MiB: 0 },
    });
  });

  test("counts a non-finite or negative size as empty rather than corrupting a bucket", () => {
    const histogram = new Base64FileReadSizeHistogram();
    histogram.record("read_file_base64", Number.NaN, true);
    histogram.record("read_file_base64", -5, true);
    expect(histogram.snapshot().read_file_base64).toMatchObject({
      count: 2,
      maxBytes: 0,
      buckets: { upTo64KiB: 2 },
    });
  });

  test("hands out copies, so a reader of the snapshot cannot change the counts", () => {
    const histogram = new Base64FileReadSizeHistogram();
    histogram.record("read_file_base64", 10, true);
    const first = histogram.snapshot();
    first.read_file_base64.count = 99;
    first.read_file_base64.buckets.upTo64KiB = 99;
    expect(histogram.snapshot().read_file_base64).toMatchObject({
      count: 1,
      buckets: { upTo64KiB: 1 },
    });
  });
});
