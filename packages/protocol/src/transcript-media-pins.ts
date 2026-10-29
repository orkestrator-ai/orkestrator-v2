/**
 * Transcript media pins: the bytes of a local image as it was when a
 * transcript message first showed it.
 *
 * A transcript names local images by path, and agents overwrite files. Without
 * a pin, an earlier message would show whatever the file holds now, and a
 * renderer cache keyed by path would keep showing whatever it read first. A
 * pin belongs to one message's reference to one file, so two messages that
 * name the same file keep their own versions. The first read wins; later reads
 * of the same pin return the saved bytes and never touch the file again.
 *
 * Pins are created on first display, not when the agent wrote the file. A
 * message first displayed after its file was overwritten is pinned to the
 * newer bytes; `fileModifiedAt` lets the renderer say so.
 */

export const TRANSCRIPT_MEDIA_PIN_COMMAND = "transcript_media_pin";

/** One message's reference to one image file. */
export interface TranscriptMediaPinRequest {
  environmentId: string;
  logicalSessionKey: string;
  /** The source message that names the file (not a coalesced display row). */
  messageId: string;
  /** Absolute host path, or with `containerId` a `/workspace` path. */
  path: string;
  /** Must name the environment's own container when given. */
  containerId?: string;
}

/**
 * Why the bytes returned are the file as it is now rather than a saved copy:
 * the environment's pin storage is full, or a saved copy is missing.
 */
export type TranscriptMediaLiveReason = "quota" | "missing";

/** Provenance of image bytes a transcript shows. */
export interface TranscriptMediaSnapshot {
  /**
   * `pinned`: the bytes saved when this message first showed the file.
   * `live`: the file as it is now; no copy could be kept.
   */
  status: "pinned" | "live";
  /** When the bytes were read (first display for a pin). */
  capturedAt: string;
  /** The file's modification time when it was read, when the reader knows it. */
  fileModifiedAt?: string;
  reason?: TranscriptMediaLiveReason;
}

export interface TranscriptMediaPinResponse extends TranscriptMediaSnapshot {
  /** SHA-256 of the bytes returned. */
  sha256: string;
  byteLength: number;
  dataBase64: string;
}
