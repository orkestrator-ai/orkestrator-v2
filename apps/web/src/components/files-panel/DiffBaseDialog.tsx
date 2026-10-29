import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import type { DiffBaseBranch, DiffBaseCommit } from "@orkestrator/protocol/diff-stats";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as backend from "@/lib/backend";
import { formatRelativeTime } from "@/lib/format-relative-time";
import { useConfigStore, useEnvironmentStore } from "@/stores";
import type { Environment } from "@/types";

interface DiffBaseDialogProps {
  environmentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** One answer from the backend, tagged with the request it answers. */
interface Loaded<T> {
  key: string;
  value?: T;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const pendingSaves = new Map<string, Promise<boolean>>();

/**
 * Saves (or, with `null`, clears) an environment's comparison base and applies
 * the answer locally without waiting for the environment snapshot. Reports a
 * failure itself; resolves to whether it saved.
 */
export function saveDiffBase(
  environmentId: string,
  base: { ref: string; commit: string } | null,
): Promise<boolean> {
  const previous = pendingSaves.get(environmentId);
  const save = async (): Promise<boolean> => {
    try {
      const updated = await backend.setEnvironmentDiffBase(environmentId, base);
      // Requests and response updates run in order, across every entry point.
      // Apply successful earlier saves even if a later queued save might fail.
      useEnvironmentStore.getState().updateEnvironment(environmentId, {
        diffBaseOverride: updated.diffBaseOverride ?? null,
      });
      return true;
    } catch (error) {
      toast.error("Could not change the comparison base", { description: errorMessage(error) });
      return false;
    }
  };
  const task = (previous ?? Promise.resolve(true)).then(save);
  pendingSaves.set(environmentId, task);
  void task.finally(() => {
    if (pendingSaves.get(environmentId) === task) pendingSaves.delete(environmentId);
  });
  return task;
}

/**
 * The branch to preselect: the current choice, else the remote copy of the
 * branch this environment targets, else its local copy, else the newest branch.
 */
export function defaultDiffBaseRef(
  branches: DiffBaseBranch[],
  environment: Pick<Environment, "diffBaseOverride" | "prBaseBranch" | "delegationBaseBranch">,
  repository: { prBaseBranch?: string; defaultBranch?: string } | null,
): string | null {
  const refs = new Set(branches.map((branch) => branch.ref));
  const current = environment.diffBaseOverride?.ref;
  if (current && refs.has(current)) return current;
  const target =
    environment.prBaseBranch?.trim() ||
    environment.delegationBaseBranch?.trim() ||
    repository?.prBaseBranch?.trim() ||
    repository?.defaultBranch?.trim() ||
    "main";
  for (const ref of [`refs/remotes/origin/${target}`, `refs/heads/${target}`]) {
    if (refs.has(ref)) return ref;
  }
  return branches[0]?.ref ?? null;
}

/**
 * Picks the commit an environment's Changes are measured from: a branch, then
 * one of its commits by subject. Merging the target branch in and choosing its
 * tip leaves only what this branch adds on top of it.
 */
export function DiffBaseDialog({ environmentId, open, onOpenChange }: DiffBaseDialogProps) {
  const environment = useEnvironmentStore((state) =>
    environmentId ? state.environments.find((candidate) => candidate.id === environmentId) : null,
  );
  return (
    <Dialog open={open && !!environment} onOpenChange={onOpenChange}>
      <DialogContent size="md">
        {/* Mounted per opening so every opening starts from the stored choice. */}
        {open && environment && (
          <DiffBaseForm
            key={environment.id}
            environment={environment}
            onDone={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DiffBaseForm({ environment, onDone }: { environment: Environment; onDone: () => void }) {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const branchId = useId();
  const commitId = useId();
  const repository = useConfigStore(
    (state) => state.config.repositories[environment.projectId] ?? null,
  );
  const override = environment.diffBaseOverride ?? null;

  const [branches, setBranches] = useState<Loaded<DiffBaseBranch[]> | null>(null);
  useEffect(() => {
    let live = true;
    backend.listEnvironmentDiffBaseBranches(environment.id).then(
      (value) => live && setBranches({ key: environment.id, value }),
      (error: unknown) => live && setBranches({ key: environment.id, error: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [environment.id]);
  const branchLoad = branches?.key === environment.id ? branches : null;
  const branchList = branchLoad?.value ?? [];

  const [chosenRef, setChosenRef] = useState<string | null>(null);
  const selectedRef = chosenRef ?? defaultDiffBaseRef(branchList, environment, repository);

  const [commits, setCommits] = useState<Loaded<DiffBaseCommit[]> | null>(null);
  useEffect(() => {
    if (!selectedRef) return;
    let live = true;
    backend.listEnvironmentDiffBaseCommits(environment.id, selectedRef).then(
      (value) => live && setCommits({ key: `${environment.id}:${selectedRef}`, value }),
      (error: unknown) =>
        live && setCommits({ key: `${environment.id}:${selectedRef}`, error: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [environment.id, selectedRef]);
  // An answer for a different branch is still loading as far as this one goes.
  const commitLoad = commits && commits.key === `${environment.id}:${selectedRef}` ? commits : null;
  const fetchedCommits = commitLoad?.value ?? [];
  const savedCommit = override?.ref === selectedRef ? override : null;
  const commitList: DiffBaseCommit[] =
    commitLoad?.value &&
    savedCommit &&
    !fetchedCommits.some((item) => item.commit === savedCommit.commit)
      ? [
          ...fetchedCommits,
          {
            ...savedCommit,
            subject: savedCommit.subject ?? "Saved comparison base",
            author: "",
            committedAt: "",
          },
        ]
      : fetchedCommits;

  const [chosenCommit, setChosenCommit] = useState<string | null>(null);
  const listed = (commit: string | null | undefined) =>
    !!commit && commitList.some((candidate) => candidate.commit === commit);
  const selectedCommit = listed(chosenCommit)
    ? chosenCommit
    : override?.ref === selectedRef && listed(override.commit)
      ? override.commit
      : (commitList[0]?.commit ?? null);

  const [saving, setSaving] = useState(false);
  const save = async (base: { ref: string; commit: string } | null) => {
    setSaving(true);
    const saved = await saveDiffBase(environment.id, base);
    if (mounted.current) {
      setSaving(false);
      if (saved) onDone();
    }
  };

  const localBranches = branchList.filter((branch) => branch.kind === "local");
  const remoteBranches = branchList.filter((branch) => branch.kind === "remote");
  const loadError = branchLoad?.error ?? commitLoad?.error;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Compare changes against</DialogTitle>
        <DialogDescription>
          Changes are shown relative to the commit you pick. After merging the latest main into this
          branch, pick the tip of main to see only what this branch adds.
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor={branchId}>Branch</Label>
          <Select
            value={selectedRef ?? ""}
            onValueChange={(ref) => {
              setChosenRef(ref);
              setChosenCommit(null);
            }}
            disabled={!branchLoad?.value || saving}
          >
            <SelectTrigger id={branchId} className="w-full">
              <SelectValue placeholder={branches ? "No branches" : "Loading branches…"} />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-80">
              {localBranches.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Local</SelectLabel>
                  {localBranches.map((branch) => (
                    <SelectItem key={branch.ref} value={branch.ref}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
              {remoteBranches.length > 0 && (
                <SelectGroup>
                  <SelectLabel>Remote</SelectLabel>
                  {remoteBranches.map((branch) => (
                    <SelectItem key={branch.ref} value={branch.ref}>
                      {branch.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              )}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2">
          <Label htmlFor={commitId}>Commit</Label>
          <Select
            value={selectedCommit ?? ""}
            onValueChange={setChosenCommit}
            disabled={!commitLoad?.value || saving}
          >
            <SelectTrigger id={commitId} className="w-full min-w-0">
              <SelectValue
                placeholder={
                  !selectedRef ? "Choose a branch" : commitLoad ? "No commits" : "Loading commits…"
                }
              />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-80 max-w-[min(36rem,90vw)]">
              {commitList.map((commit, index) => (
                <SelectItem key={commit.commit} value={commit.commit} title={commit.commit}>
                  <span className="min-w-0 truncate">{commit.subject || "(no subject)"}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {index === 0 && fetchedCommits.length > 0 ? "latest · " : ""}
                    {formatRelativeTime(commit.committedAt)}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {loadError && <p className="text-sm text-destructive">{loadError}</p>}
      </div>

      <DialogFooter>
        {override && (
          <Button
            variant="ghost"
            className="sm:mr-auto"
            disabled={saving}
            onClick={() => void save(null)}
          >
            Use automatic base
          </Button>
        )}
        <Button variant="outline" disabled={saving} onClick={onDone}>
          Cancel
        </Button>
        <Button
          disabled={
            saving || !branchLoad?.value || !commitLoad?.value || !selectedRef || !selectedCommit
          }
          onClick={() =>
            selectedRef && selectedCommit && void save({ ref: selectedRef, commit: selectedCommit })
          }
        >
          Compare
        </Button>
      </DialogFooter>
    </>
  );
}
