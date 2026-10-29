import { useState } from "react";
import { GitCommitHorizontal } from "lucide-react";
import { shortDiffBaseRefName } from "@orkestrator/protocol/diff-stats";
import { Button } from "@/components/ui/button";
import { useEnvironmentStore } from "@/stores";
import { saveDiffBase } from "./DiffBaseDialog";

interface DiffBaseNoticeProps {
  environmentId: string | null;
  onChange: () => void;
}

/** Says which commit the Changes list is measured from while the user has picked one. */
export function DiffBaseNotice({ environmentId, onChange }: DiffBaseNoticeProps) {
  const override = useEnvironmentStore((state) =>
    environmentId
      ? state.environments.find((environment) => environment.id === environmentId)?.diffBaseOverride
      : null,
  );
  const [clearing, setClearing] = useState(false);
  if (!environmentId || !override) return null;
  const label = override.subject || override.commit.slice(0, 12);

  return (
    <div
      className="flex items-center gap-2 border-b border-border/60 bg-chrome/60 px-3 py-1.5 text-xs text-muted-foreground"
      data-testid="diff-base-notice"
    >
      <GitCommitHorizontal className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate" title={`${override.commit} on ${override.ref}`}>
        Compared with <span className="text-foreground">{shortDiffBaseRefName(override.ref)}</span>{" "}
        · {label}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={onChange}>
          Change
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          disabled={clearing}
          onClick={() => {
            setClearing(true);
            void saveDiffBase(environmentId, null).finally(() => setClearing(false));
          }}
        >
          Reset
        </Button>
      </div>
    </div>
  );
}
