/**
 * How large the whole-file base64 reads are that still cross the command
 * channel (to-do 5800 task 2). The per-command totals in `commands` give a
 * count and a byte sum, which cannot tell many small reads from a few large
 * ones; this keeps a fixed-bucket histogram of each successful answer's size
 * for exactly these three commands. Sizes only: never a path, an argument or
 * a byte of the file. In memory, so it covers the backend's current uptime.
 */

/** The readers whose answers carry a whole file as base64. */
export const BASE64_FILE_READ_COMMANDS = [
  "read_file_base64",
  "read_environment_file_base64",
  "read_container_file_base64",
] as const;

export type Base64FileReadCommand = (typeof BASE64_FILE_READ_COMMANDS)[number];

const KIB = 1024;
const MIB = 1024 * KIB;

/**
 * Inclusive upper bounds of the response-body buckets. A file at the 10 MiB
 * `MAX_BINARY_FILE_BYTES` limit encodes to about 13.4 MiB, so the last bound
 * holds every admitted read and `over16MiB` should stay at zero.
 */
export const BASE64_FILE_READ_SIZE_BUCKETS = [
  { label: "upTo64KiB", maxBytes: 64 * KIB },
  { label: "upTo256KiB", maxBytes: 256 * KIB },
  { label: "upTo1MiB", maxBytes: MIB },
  { label: "upTo4MiB", maxBytes: 4 * MIB },
  { label: "upTo8MiB", maxBytes: 8 * MIB },
  { label: "upTo16MiB", maxBytes: 16 * MIB },
] as const;

export type Base64FileReadSizeLabel =
  (typeof BASE64_FILE_READ_SIZE_BUCKETS)[number]["label"] | "over16MiB";

export type Base64FileReadSizes = {
  /** Successful answers counted. Failures are small error bodies and are left out. */
  count: number;
  /** Largest answer seen, in bytes. */
  maxBytes: number;
  buckets: Record<Base64FileReadSizeLabel, number>;
};

function emptySizes(): Base64FileReadSizes {
  const buckets = {} as Record<Base64FileReadSizeLabel, number>;
  for (const bucket of BASE64_FILE_READ_SIZE_BUCKETS) buckets[bucket.label] = 0;
  buckets.over16MiB = 0;
  return { count: 0, maxBytes: 0, buckets };
}

function bucketFor(bytes: number): Base64FileReadSizeLabel {
  return (
    BASE64_FILE_READ_SIZE_BUCKETS.find((bucket) => bytes <= bucket.maxBytes)?.label ?? "over16MiB"
  );
}

function isBase64FileReadCommand(command: string): command is Base64FileReadCommand {
  return (BASE64_FILE_READ_COMMANDS as readonly string[]).includes(command);
}

export class Base64FileReadSizeHistogram {
  private readonly sizes = new Map<Base64FileReadCommand, Base64FileReadSizes>(
    BASE64_FILE_READ_COMMANDS.map((command) => [command, emptySizes()]),
  );

  /** Counts one answer; any other command, and any failure, is ignored. */
  record(command: string, responseBytes: number, success: boolean): void {
    if (!success || !isBase64FileReadCommand(command)) return;
    const bytes = Number.isFinite(responseBytes) ? Math.max(0, Math.floor(responseBytes)) : 0;
    const sizes = this.sizes.get(command)!;
    sizes.count += 1;
    sizes.maxBytes = Math.max(sizes.maxBytes, bytes);
    sizes.buckets[bucketFor(bytes)] += 1;
  }

  /** Every command, zeros included, so the shape never depends on what was read. */
  snapshot(): Record<Base64FileReadCommand, Base64FileReadSizes> {
    return Object.fromEntries(
      Array.from(this.sizes, ([command, sizes]) => [
        command,
        { count: sizes.count, maxBytes: sizes.maxBytes, buckets: { ...sizes.buckets } },
      ]),
    ) as Record<Base64FileReadCommand, Base64FileReadSizes>;
  }
}
