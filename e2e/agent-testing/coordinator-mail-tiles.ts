import {
  createPeerMailNativeMessagesFromCarrier,
  isPeerMailCarrierContent,
} from "../../apps/web/src/lib/chat/client-only-messages";
import type {
  CoordinatorLiveCheck,
  CoordinatorTranscriptMessage,
} from "../../apps/desktop/scripts/dev/coordinator-live";
import type { DelegationMailMessage } from "../../apps/desktop/scripts/dev/coordinator-live-delegation";

/**
 * Mail tiles, judged per platform from the provider's own echo.
 *
 * Each provider writes the injected carrier back into its transcript as a
 * user row, in its own way. The transcript shows that row through
 * `createPeerMailNativeMessagesFromCarrier`, the renderer's parser, only when
 * `isPeerMailCarrierContent` recognises the row's content; otherwise the raw
 * carrier is shown as if a person had typed it. So the check runs the same two
 * functions over every echoed row and requires one tile per delivered message,
 * nothing raw, nothing dropped, and each notice tile toned as its notice.
 *
 * Imports the renderer module directly, so it lives beside the spec rather
 * than in `apps/desktop/scripts`, whose NodeNext build cannot resolve it.
 */

const CARRIER_OPEN = '<orkestrator-peer-message version="1">';

export interface MailTileObservation {
  /** User rows holding at least one carrier. */
  carrierRows: number;
  /** Carrier rows the renderer shows as tiles, and of those, rows with several tiles. */
  tileRows: number;
  batchedRows: number;
  tiles: number;
}

/** Every text a row holds, wherever the provider put it. */
function rowText(message: CoordinatorTranscriptMessage): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  return [
    typeof message.content === "string" ? message.content : "",
    ...parts.map((part) => {
      const record = part as { content?: unknown; text?: unknown };
      return typeof record.content === "string"
        ? record.content
        : typeof record.text === "string"
          ? record.text
          : "";
    }),
  ].join("\n");
}

function check(name: string, passed: boolean, detail?: string): CoordinatorLiveCheck {
  return { name, passed, ...(detail ? { detail: detail.slice(0, 500) } : {}) };
}

/**
 * The mail-tile checks for one mailbox's transcript. `delivered` is every
 * message the store says it injected into that mailbox; `requireBatched`
 * asks for at least one row carrying several messages.
 */
export function evaluateMailTiles(input: {
  messages: readonly CoordinatorTranscriptMessage[];
  delivered: readonly DelegationMailMessage[];
  requireBatched?: boolean;
  prefix?: string;
}): { checks: CoordinatorLiveCheck[]; observed: MailTileObservation } {
  const name = (suffix: string) => `${input.prefix ?? "mail-tiles"}-${suffix}`;
  const tilesById = new Map<string, number>();
  const raw: number[] = [];
  const dropped: number[] = [];
  const residue: number[] = [];
  const toneMismatch: string[] = [];
  const tones = new Map(
    input.delivered.map((message) => [message.id, message.notice?.tone] as const),
  );
  const observed: MailTileObservation = { carrierRows: 0, tileRows: 0, batchedRows: 0, tiles: 0 };
  for (const [index, message] of input.messages.entries()) {
    if (message.role !== "user") continue;
    if (!rowText(message).includes(CARRIER_OPEN)) continue;
    observed.carrierRows += 1;
    // The renderer reads `content` alone: a carrier only in the parts is
    // shown raw.
    const content = typeof message.content === "string" ? message.content : "";
    const carriers = content.split(CARRIER_OPEN).length - 1;
    if (!isPeerMailCarrierContent(content)) {
      raw.push(index);
      continue;
    }
    const tiles = createPeerMailNativeMessagesFromCarrier({ content, createdAt: "" });
    observed.tileRows += 1;
    observed.tiles += tiles.length;
    if (tiles.length > 1) observed.batchedRows += 1;
    if (tiles.length !== carriers) dropped.push(index);
    // Text outside every carrier is hidden by the tiles, so a provider that
    // adds its own words to the echo would lose them silently.
    const outside = content.replace(
      /<orkestrator-peer-message version="1">[\s\S]*?<\/orkestrator-peer-message>/g,
      "",
    );
    if (outside.trim()) residue.push(index);
    for (const tile of tiles) {
      const id = tile.peerMail?.messageId;
      if (!id) continue;
      tilesById.set(id, (tilesById.get(id) ?? 0) + 1);
      const expected = tones.get(id);
      if (expected !== undefined && tile.peerMail?.notice?.tone !== expected) {
        toneMismatch.push(`${tile.peerMail?.notice?.tone ?? "none"} for ${expected}`);
      }
    }
  }
  const missing = input.delivered.filter((message) => !tilesById.has(message.id)).length;
  const repeated = [...tilesById.values()].filter((count) => count > 1).length;
  const checks = [
    check(
      name("no-raw-carrier"),
      raw.length === 0,
      raw.length > 0 ? `rows shown as raw carrier text: ${raw.join(", ")}` : undefined,
    ),
    check(
      name("one-per-message"),
      missing === 0 && repeated === 0 && dropped.length === 0,
      `${input.delivered.length} delivered, ${observed.tiles} tiles in ${observed.tileRows} rows; ${missing} without a tile, ${repeated} shown twice${dropped.length > 0 ? `, carriers dropped in rows ${dropped.join(", ")}` : ""}`,
    ),
    check(
      name("nothing-outside-carriers"),
      residue.length === 0,
      residue.length > 0 ? `text outside the carriers in rows ${residue.join(", ")}` : undefined,
    ),
    check(
      name("notice-tone"),
      toneMismatch.length === 0,
      toneMismatch.length > 0 ? `tiles toned ${toneMismatch.join(", ")}` : undefined,
    ),
  ];
  if (input.requireBatched) {
    checks.push(
      check(
        name("batched"),
        observed.batchedRows > 0,
        `${observed.batchedRows} rows with several tiles`,
      ),
    );
  }
  return { checks, observed };
}
