/**
 * The timestamp shown under each transcript block in native agent tabs.
 *
 * A block from today shows only its time ("10:42"). A block from any other
 * day also names the day ("Mar 21, 10:42"), and one from another year adds the
 * year, so a conversation resumed after a few days does not read as if it all
 * happened this morning. "Today" is the viewer's local calendar day.
 *
 * Returns "" for an unparseable input, or when the platform formatter throws,
 * so a bad timestamp never takes the message down with it.
 */
export function formatTranscriptTimestamp(isoString: string, now: Date = new Date()): string {
  try {
    const date = new Date(isoString);
    if (Number.isNaN(date.valueOf())) return "";
    const time = date.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
    if (isSameLocalDay(date, now)) return time;
    const day = date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    });
    return `${day}, ${time}`;
  } catch {
    return "";
  }
}

function isSameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
