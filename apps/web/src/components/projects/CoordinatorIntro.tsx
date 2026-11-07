import { CircleHelp, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUIChromeStore } from "@/stores/uiChromeStore";

/**
 * How the coordinator differs from every other agent tab, in one place: it is
 * read-only, it delegates and is woken by mail, it has side agents, and its
 * platform is fixed per conversation.
 */
export const COORDINATOR_INTRO_LINES: readonly string[] = [
  "The coordinator reads and searches this checkout but never changes it.",
  "It hands changes to build pipelines and prompt environments, and is woken when they finish. You don't need to wait.",
  "Side agents are extra read-only chats that can talk to the main coordinator.",
  "To switch AI provider, use Change agent. Your workers carry over.",
];

function CoordinatorIntroLines() {
  return (
    <ul className="list-disc space-y-1 pl-4 text-left">
      {COORDINATOR_INTRO_LINES.map((line) => (
        <li key={line}>{line}</li>
      ))}
    </ul>
  );
}

/**
 * The first-run card in the empty main composer. Dismissing it is a view
 * preference stored per user in the UI store, so it stays dismissed in every
 * project; the toolbar's "?" shows the same lines again.
 */
export function CoordinatorIntroCard() {
  const dismissed = useUIChromeStore((state) => state.coordinatorIntroDismissed);
  const dismiss = useUIChromeStore((state) => state.setCoordinatorIntroDismissed);
  if (dismissed) return null;
  return (
    <section
      aria-label="How the coordinator works"
      data-coordinator-intro-card
      className="relative w-full rounded-lg border border-border/70 bg-elevated px-4 py-3 pr-10 text-xs leading-relaxed text-muted-foreground"
    >
      <h3 className="mb-1.5 text-sm font-medium text-foreground">How the coordinator works</h3>
      <CoordinatorIntroLines />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="absolute top-1.5 right-1.5 size-7"
        aria-label="Dismiss how the coordinator works"
        title="Dismiss. The ? in the toolbar shows this again."
        onClick={() => dismiss(true)}
      >
        <X className="size-3.5" />
      </Button>
    </section>
  );
}

/**
 * The toolbar's "?": the first-run card's lines, available whatever the
 * conversation's state. A menu rather than a tooltip, so it opens by touch.
 */
export function CoordinatorIntroButton() {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          aria-label="How the coordinator works"
          title="How the coordinator works"
        >
          <CircleHelp className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="max-w-sm p-3 text-xs leading-relaxed"
        data-coordinator-intro-menu
      >
        <p className="mb-1.5 text-sm font-medium text-foreground">How the coordinator works</p>
        <CoordinatorIntroLines />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
