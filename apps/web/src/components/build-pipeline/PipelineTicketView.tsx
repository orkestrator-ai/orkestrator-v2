import { useMemo, useState } from "react";
import { AlertTriangle, ClipboardList, Image as ImageIcon, MessageSquare } from "lucide-react";
import type { BuildPipeline, TaskSnapshot } from "@orkestrator/protocol/build-pipeline";
import { sectionsFromTicketText } from "@orkestrator/protocol/ticket-sections";
import { MarkdownBody } from "@/components/pull-requests/pull-request-shared";
import { TicketSectionsGrid } from "@/components/tickets/TicketSectionsGrid";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useKanbanStore } from "@/stores/kanbanStore";

const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
};

/**
 * A `data:` URL for a snapshot image. Kanban stores images as bare base64
 * (WebP unless the name says otherwise); anything else is not shown.
 * SVGs stay in an img element, whose image context disables scripts and external resources.
 */
export function ticketImageUrl(image: TaskSnapshot["images"][number]): string | null {
  if (!/^[A-Za-z0-9+/=\s]+$/.test(image.data)) return null;
  const dot = image.filename.lastIndexOf(".");
  const extension = dot < 0 ? "" : image.filename.slice(dot + 1).toLowerCase();
  const type = IMAGE_TYPES[extension] ?? (extension ? null : "image/webp");
  return type ? `data:${type};base64,${image.data.replace(/\s/g, "")}` : null;
}

/**
 * Whether the live Kanban ticket now reads differently from the snapshot the
 * pipeline started with. Only a ticket the board has already loaded is
 * compared; nothing is fetched for it.
 */
export function ticketChangedSinceStart(
  snapshot: TaskSnapshot,
  live: { title: string; description: string; acceptanceCriteria: string } | undefined,
): boolean {
  if (!live) return false;
  return (
    live.title.trim() !== snapshot.title.trim() ||
    live.description.trim() !== snapshot.description.trim() ||
    live.acceptanceCriteria.trim() !== snapshot.acceptanceCriteria.trim()
  );
}

function Section({
  icon: Icon,
  title,
  children,
}: {
  icon: typeof ClipboardList;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0" aria-label={title}>
      <h4 className="mb-2 flex items-center gap-1.5 text-sm font-medium">
        <Icon className="size-4 text-muted-foreground" aria-hidden="true" />
        {title}
      </h4>
      {children}
    </section>
  );
}

/**
 * The ticket a pipeline was started with: its stored snapshot, never the live
 * Kanban ticket and never the prompt built from it, shown as section tiles.
 * Empty sections are left out; a pipeline with no snapshot says so.
 */
export function PipelineTicketView({ pipeline }: { pipeline: BuildPipeline }) {
  const snapshot = pipeline.taskSnapshot as TaskSnapshot | undefined;
  const liveTask = useKanbanStore((state) =>
    pipeline.source?.type === "kanban" || !pipeline.source
      ? state.tasks.find((task) => task.id === pipeline.taskId)
      : undefined,
  );
  const [preview, setPreview] = useState<{ url: string; filename: string } | null>(null);
  const sections = useMemo(
    () =>
      snapshot
        ? sectionsFromTicketText(snapshot.description ?? "", snapshot.acceptanceCriteria ?? "", {
            now: pipeline.createdAt,
          })
        : {},
    [snapshot, pipeline.createdAt],
  );
  if (!snapshot || (!snapshot.title?.trim() && !snapshot.description?.trim())) {
    return (
      <p data-testid="pipeline-ticket-placeholder" className="text-sm text-muted-foreground">
        This build did not store the ticket it started with.
        {pipeline.taskTitle ? ` It was started for “${pipeline.taskTitle}”.` : ""}
      </p>
    );
  }
  const comments = snapshot.comments.filter((comment) => comment.text.trim());
  const images = snapshot.images.flatMap((image) => {
    const url = ticketImageUrl(image);
    return url ? [{ url, filename: image.filename }] : [];
  });
  const changed = ticketChangedSinceStart(snapshot, liveTask);
  return (
    <article data-testid="pipeline-ticket" className="flex min-w-0 flex-col gap-5 pb-6">
      <header className="min-w-0">
        <h3 className="text-base font-semibold break-words">{snapshot.title}</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          The ticket as it was when this build started.
        </p>
        {changed ? (
          <p
            data-testid="pipeline-ticket-changed"
            className="mt-2 flex items-center gap-1.5 text-xs text-amber-500"
          >
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
            The ticket has been edited since; this build works from the version shown here.
          </p>
        ) : null}
      </header>
      <TicketSectionsGrid sections={sections} />
      {images.length > 0 ? (
        <Section icon={ImageIcon} title={`Reference images (${images.length})`}>
          <div className="flex flex-wrap gap-2">
            {images.map((image, index) => (
              <button
                key={`${image.filename}-${index}`}
                type="button"
                className="size-24 overflow-hidden rounded-md border border-border transition-colors hover:border-primary/50"
                aria-label={`Show image ${image.filename}`}
                onClick={() => setPreview(image)}
              >
                <img src={image.url} alt={image.filename} className="size-full object-cover" />
              </button>
            ))}
          </div>
        </Section>
      ) : null}
      {comments.length > 0 ? (
        <Section icon={MessageSquare} title={`Comments (${comments.length})`}>
          <ul className="flex flex-col gap-2">
            {comments.map((comment, index) => (
              <li key={index} className="rounded-md border border-border/60 bg-muted/20 px-3 py-2">
                <MarkdownBody body={comment.text} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      <Dialog open={preview !== null} onOpenChange={(open) => !open && setPreview(null)}>
        <DialogContent className="max-w-4xl">
          <DialogTitle className="truncate text-sm">{preview?.filename}</DialogTitle>
          {preview ? (
            <img src={preview.url} alt={preview.filename} className="max-h-[75vh] object-contain" />
          ) : null}
        </DialogContent>
      </Dialog>
    </article>
  );
}
