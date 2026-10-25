import { useEffect, useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import * as backend from "@/lib/backend";
import { writeText } from "@/lib/native/clipboard";
import { frameworkHints, PLACEHOLDER_PREVIEW_ORIGIN } from "@/lib/preview-framework-hints";

export interface PreviewFrameworkHintsProps {
  serviceId: string;
  applicationPort: number;
}

/**
 * Optional, copyable setup hints with this service's private origin filled in
 * when it is published. Nothing here touches the user's project.
 */
export function PreviewFrameworkHints({ serviceId, applicationPort }: PreviewFrameworkHintsProps) {
  const [origin, setOrigin] = useState<{ serviceId: string; value: string | null } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void backend
      .getPreviewPublicOrigin(serviceId)
      .then((result) => {
        if (!cancelled) setOrigin({ serviceId, value: result.origin });
      })
      .catch(() => {
        if (!cancelled) setOrigin({ serviceId, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [serviceId]);

  const known = origin?.serviceId === serviceId ? origin.value : null;
  const hints = frameworkHints({ origin: known, applicationPort });
  const copy = (text: string) => {
    void writeText(text)
      .then(() => toast.success("Copied"))
      .catch(() => toast.error("Could not copy"));
  };

  return (
    <div className="space-y-2 font-sans text-[11px]" data-testid="preview-framework-hints">
      <p>
        {known ? (
          <>
            Public origin <code className="font-mono">{known}</code>.
          </>
        ) : (
          <>
            Not published on a private origin yet; snippets show{" "}
            <code className="font-mono">{PLACEHOLDER_PREVIEW_ORIGIN}</code>.
          </>
        )}{" "}
        Requests reach the app as{" "}
        <code className="font-mono">Host: localhost:{applicationPort}</code> with{" "}
        <code className="font-mono">X-Forwarded-Proto</code> set.
      </p>
      <ul className="space-y-2">
        {hints.map((hint) => (
          <li key={hint.id} className="rounded border border-border/60 p-1.5">
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">{hint.framework}</span>
              <span className="text-muted-foreground">{hint.versions}</span>
              <span className="flex-1" />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-5 gap-1 px-1.5 text-[11px]"
                aria-label={`Copy the ${hint.framework} snippet`}
                onClick={() => copy(hint.snippet)}
              >
                <Copy className="h-3 w-3" />
                Copy
              </Button>
            </div>
            <p className="mt-0.5 text-muted-foreground">{hint.summary}</p>
            <p className="mt-1 text-muted-foreground">{hint.file}</p>
            <pre className="mt-0.5 overflow-x-auto rounded bg-muted/40 p-1 font-mono">
              {hint.snippet}
            </pre>
          </li>
        ))}
      </ul>
    </div>
  );
}
