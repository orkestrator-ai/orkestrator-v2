import type { MediaSnapshotNote } from "@/lib/chat/media-snapshot";

/** A corner label on a transcript image whose bytes may not be what its message showed. */
export function MediaSnapshotBadge({ note }: { note: MediaSnapshotNote }) {
  return (
    <span
      data-rich-chrome="true"
      data-media-snapshot={note.kind}
      title={note.description}
      className="absolute left-1.5 top-1.5 rounded bg-background/90 px-1.5 py-0.5 text-[10px] text-muted-foreground"
    >
      {note.text}
    </span>
  );
}
