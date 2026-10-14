/**
 * An in-memory stand-in for OpenCode's `GET /session/:id/message`.
 *
 * It follows the server's paging contract as shipped (`MessageV2.page`):
 * messages ordered by `(time_created, id)`, `limit` newest returned oldest
 * first, and `before` a base64url `{ id, time }` cursor selecting rows strictly
 * older than that pair. Several messages share a creation time on purpose, so
 * a cursor that ignored the id tiebreak would skip or repeat them.
 */
export interface OpenCodeHistoryServer {
  messages: Array<{
    info: { id: string; time: { created: number }; [key: string]: unknown };
    parts: Array<Record<string, unknown>>;
  }>;
  read(limit?: number, before?: string): unknown[];
  remove(id: string): void;
}

export function openCodeMessageId(index: number): string {
  return `msg_${index.toString(16).padStart(12, "0")}${"a".repeat(14)}`;
}

export function openCodeHistoryServer(
  count: number,
  text: (index: number) => string = (index) => `step ${index}`,
): OpenCodeHistoryServer {
  const messages: OpenCodeHistoryServer["messages"] = Array.from({ length: count }, (_, index) => {
    const id = openCodeMessageId(index);
    return {
      info: {
        id,
        sessionID: "owned-session",
        role: index % 10 === 0 ? "user" : "assistant",
        time: { created: 1_000 + Math.floor(index / 3) },
      },
      parts: [{ id: `part-${index}`, messageID: id, type: "text", text: text(index) }],
    };
  });
  return {
    messages,
    read(limit, before) {
      let pool = messages;
      if (before !== undefined) {
        const cursor = JSON.parse(Buffer.from(before, "base64url").toString("utf8")) as {
          id: string;
          time: number;
        };
        pool = messages.filter(({ info }) =>
          info.time.created === cursor.time ? info.id < cursor.id : info.time.created < cursor.time,
        );
      }
      return limit === undefined ? [...pool] : pool.slice(Math.max(0, pool.length - limit));
    },
    remove(id) {
      const index = messages.findIndex((message) => message.info.id === id);
      if (index >= 0) messages.splice(index, 1);
    },
  };
}
