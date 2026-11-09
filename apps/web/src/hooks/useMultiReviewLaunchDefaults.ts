import { useEffect, useState } from "react";
import { incompatibility } from "@orkestrator/protocol/contract/errors";
import type { MultiReviewResolvedDefaults } from "@/components/review/MultiReviewLaunchDialog";
import { useScopeBackend } from "@/hooks/useScopeBackend";

/**
 * The Multi Review rows a plain click would run on `environmentId`, read from
 * that environment's node each time the configure dialog opens.
 *
 * The node resolves them from its saved settings and its own model catalogue
 * (`get_multi_review_launch_defaults`), so the dialog never opens on a model
 * the window picked from its own, possibly stale, copy of the catalogue. A node
 * that predates the command answers `unsupported`, and the dialog falls back to
 * the rows it builds itself.
 */
export function useMultiReviewLaunchDefaults(
  open: boolean,
  environmentId: string | null | undefined,
): MultiReviewResolvedDefaults | undefined {
  const backend = useScopeBackend();
  // Each open is its own request, so a reopen never shows the previous answer.
  const [request, setRequest] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setRequest((current) => current + 1);
  }
  const key = `${request}:${environmentId ?? ""}`;
  const [answer, setAnswer] = useState<{
    key: string;
    defaults: MultiReviewResolvedDefaults;
  } | null>(null);

  useEffect(() => {
    if (!open || !environmentId) return;
    let cancelled = false;
    backend.getMultiReviewLaunchDefaults(environmentId).then(
      (rows) => {
        if (cancelled) return;
        setAnswer({
          key,
          defaults: {
            status: "ready",
            selection: {
              reviewers: rows.reviewers,
              reviewModel: rows.reviewModel,
              fixModel: rows.fixModel,
              autoFix: rows.autoFix,
              autoPr: rows.autoPr,
            },
          },
        });
      },
      (error: unknown) => {
        if (cancelled) return;
        setAnswer({
          key,
          defaults:
            incompatibility(error, "get_multi_review_launch_defaults")?.code === "unknown-command"
              ? { status: "unsupported" }
              : {
                  status: "failed",
                  message: error instanceof Error ? error.message : String(error),
                },
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [backend, environmentId, key, open]);

  if (!open || !environmentId) return undefined;
  return answer?.key === key ? answer.defaults : { status: "loading" };
}
