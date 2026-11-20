import { useState } from "react";
import { Loader2, Search } from "lucide-react";

import type { CapabilityRegistryPackageList } from "@orkestrator/protocol/capability-resources-api";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { capabilitiesApi } from "@/lib/backend/capabilities";

import { describeError, Pill } from "./capability-format";
import { useCapabilityResource } from "./useCapabilityResource";

export interface RegistryPick {
  registryId: string;
  qualifiedId: string;
}

/**
 * The Add dialog's Registry source: choose a configured registry, search its
 * index and pick a package. The latest published version is inspected; its
 * exact content is pinned like any other source.
 */
export function RegistrySourcePicker({
  value,
  onChange,
}: {
  value: RegistryPick | null;
  onChange: (value: RegistryPick | null) => void;
}) {
  const registries = useCapabilityResource(() => capabilitiesApi.listCapabilityRegistries(), []);
  const list = registries.state.data?.registries ?? [];
  const [chosen, setChosen] = useState<string | null>(null);
  const registryId = chosen ?? list[0]?.id ?? "";
  const [query, setQuery] = useState("");
  const [listing, setListing] = useState<CapabilityRegistryPackageList | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      setListing(await capabilitiesApi.listCapabilityRegistryPackages(registryId, query.trim()));
    } catch (searchError) {
      setError(describeError(searchError));
      setListing(null);
    } finally {
      setBusy(false);
    }
  };

  if (registries.state.data === null) {
    return <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />;
  }
  if (list.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="registry-source-empty">
        No package registry is configured. Add one under Setups → Registries.
      </p>
    );
  }
  return (
    <div className="space-y-3" data-testid="registry-source">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="capability-registry" className="text-xs">
            Registry
          </Label>
          <NativeSelect
            id="capability-registry"
            value={registryId}
            onChange={(event) => {
              setChosen(event.target.value);
              setListing(null);
              onChange(null);
            }}
          >
            {list.map((registry) => (
              <option key={registry.id} value={registry.id}>
                {registry.label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="capability-registry-query" className="text-xs">
            Package
          </Label>
          <div className="flex gap-2">
            <Input
              id="capability-registry-query"
              placeholder="team/review"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                const qualifiedId = event.target.value.trim();
                onChange(qualifiedId ? { registryId, qualifiedId } : null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void search();
                }
              }}
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy || !registryId}
              onClick={() => void search()}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
              Browse
            </Button>
          </div>
        </div>
      </div>
      {error ? (
        <p className="text-xs text-rose-300" role="alert">
          {error}
        </p>
      ) : null}
      {listing ? (
        listing.packages.length === 0 ? (
          <p className="text-xs text-muted-foreground">No package matches.</p>
        ) : (
          <div className="max-h-56 space-y-1 overflow-y-auto">
            {listing.packages.map((entry) => (
              <label key={entry.qualifiedId} className="flex items-center gap-2 text-xs">
                <input
                  type="radio"
                  name="capability-registry-package"
                  checked={
                    value?.registryId === listing.registryId &&
                    value.qualifiedId === entry.qualifiedId
                  }
                  onChange={() =>
                    onChange({ registryId: listing.registryId, qualifiedId: entry.qualifiedId })
                  }
                />
                <span className="text-foreground">{entry.displayName ?? entry.qualifiedId}</span>
                <Pill>{entry.latest}</Pill>
                <span className="min-w-0 truncate text-muted-foreground">
                  {entry.description ?? entry.qualifiedId}
                </span>
              </label>
            ))}
            {listing.truncated > 0 ? (
              <p className="text-[11px] text-muted-foreground">
                {listing.truncated} more; narrow the search.
              </p>
            ) : null}
          </div>
        )
      ) : null}
      <p className="text-[11px] text-muted-foreground">
        The latest version is fetched (Git with hooks off, or a tarball checked against its
        published SHA-256) and inspected before anything is enabled.
      </p>
    </div>
  );
}
