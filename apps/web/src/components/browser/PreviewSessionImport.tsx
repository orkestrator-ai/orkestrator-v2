import type { BrowserPreviewSessionImport } from "@orkestrator/protocol/browser-preview";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** What the banner says, or null when there is nothing to say. */
function notice(
  sessionImport: BrowserPreviewSessionImport,
  blockedHost: string | undefined,
): { title: string; detail: string; retry: boolean } | null {
  switch (sessionImport.state) {
    case "waiting":
      return {
        title: "Waiting for your browser.",
        detail: "It should open a one-time page that copies your sign-in here.",
        retry: false,
      };
    case "imported":
      return {
        title: "Sign-in copied and this preview reloaded.",
        detail:
          sessionImport.skipped > 0
            ? `Copied ${plural(sessionImport.cookies, "cookie")}; ${sessionImport.skipped} could not be used.`
            : `Copied ${plural(sessionImport.cookies, "cookie")}.`,
        retry: false,
      };
    case "empty":
      return {
        title: "Your default browser has no sign-in for localhost.",
        detail: "Sign in to this app in that browser first, then try again.",
        retry: true,
      };
    case "expired":
      return {
        title: "The one-time page expired.",
        detail: "Your browser did not open it in time.",
        retry: true,
      };
    case "failed":
      return {
        title: "Could not copy your sign-in.",
        detail: "Orkestrator could not open the one-time page or store the cookies.",
        retry: true,
      };
    case "idle":
      return blockedHost
        ? {
            title: `${blockedHost} can't open inside a preview.`,
            detail: "To sign in, use your browser, then bring that session here.",
            retry: true,
          }
        : null;
  }
}

export function PreviewSessionBanner({
  sessionImport,
  blockedHost,
  canOpenInBrowser,
  onOpenInBrowser,
  onBringBack,
  onDismiss,
}: {
  sessionImport: BrowserPreviewSessionImport;
  blockedHost: string | undefined;
  canOpenInBrowser: boolean;
  onOpenInBrowser: () => void;
  onBringBack: () => void;
  onDismiss: () => void;
}): ReactNode {
  const message = notice(sessionImport, blockedHost);
  if (!message) return null;
  const waiting = sessionImport.state === "waiting";
  return (
    <div
      role="status"
      aria-label="Sign-in notice"
      className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-primary/25 bg-primary/10 px-3 py-1.5 text-xs text-foreground"
    >
      <div className="min-w-0 flex-1 basis-64 break-words [overflow-wrap:anywhere]">
        <span className="font-medium">{message.title}</span>{" "}
        <span className="text-muted-foreground">{message.detail}</span>
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {message.retry && canOpenInBrowser && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7"
            onClick={onOpenInBrowser}
          >
            Open in browser
          </Button>
        )}
        {message.retry && (
          <Button type="button" size="sm" className="h-7" onClick={onBringBack}>
            Bring sign-in back
          </Button>
        )}
        {waiting ? (
          <Button type="button" variant="outline" size="sm" className="h-7" onClick={onDismiss}>
            Cancel
          </Button>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
    </div>
  );
}

/** The copy reaches further than this one app, so it is never started by a single click. */
export function PreviewSessionImportDialog({
  open,
  applicationPort,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  applicationPort: number | undefined;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}): ReactNode {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Copy your sign-in from your browser?</AlertDialogTitle>
          <AlertDialogDescription>
            Your default browser opens a one-time page, and every cookie it holds for localhost is
            copied into this preview. That includes cookies from your other local apps, and{" "}
            {applicationPort ? `the app on port ${applicationPort}` : "this app"} will receive all
            of them. Reset this site's data removes them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Copy sign-in</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
