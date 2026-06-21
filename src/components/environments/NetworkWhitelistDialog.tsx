import { useState, useEffect, useCallback } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Loader2,
  Shield,
  Globe,
  CheckCircle2,
  XCircle,
  AlertCircle,
} from "lucide-react";
import * as backend from "@/lib/backend";
import { useConfigStore } from "@/stores";
import type { Environment, DomainTestResult } from "@/types";

// Domain validation regex
const DOMAIN_REGEX = /^([a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/;

interface NetworkWhitelistDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  environment: Environment;
  onUpdate: (environment: Environment) => void;
}

export function NetworkWhitelistDialog({
  open,
  onOpenChange,
  environment,
  onUpdate,
}: NetworkWhitelistDialogProps) {
  const { config } = useConfigStore();
  const globalDomains = config.global.allowedDomains || [];

  const [useGlobalDefaults, setUseGlobalDefaults] = useState(
    !environment.allowedDomains || environment.allowedDomains.length === 0
  );
  const [customDomains, setCustomDomains] = useState(
    (environment.allowedDomains || globalDomains).join("\n")
  );
  const [domainErrors, setDomainErrors] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResults, setTestResults] = useState<DomainTestResult[] | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      const customDomainList = environment.allowedDomains ?? [];
      const hasCustom = customDomainList.length > 0;
      setUseGlobalDefaults(!hasCustom);
      setCustomDomains(
        (hasCustom ? customDomainList : globalDomains).join("\n")
      );
      setDomainErrors([]);
      setTestResults(null);
    }
  }, [open, environment.allowedDomains, globalDomains]);

  // Update custom domains when toggling to global
  useEffect(() => {
    if (useGlobalDefaults) {
      setCustomDomains(globalDomains.join("\n"));
      setDomainErrors([]);
      setTestResults(null);
    }
  }, [useGlobalDefaults, globalDomains]);

  // Validate domains locally
  const validateDomainsLocally = useCallback((domainsText: string) => {
    const domains = domainsText
      .split("\n")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    const errors: string[] = [];
    for (const domain of domains) {
      if (!DOMAIN_REGEX.test(domain)) {
        errors.push(`Invalid domain format: ${domain}`);
      }
    }
    setDomainErrors(errors);
    setTestResults(null);
    return errors.length === 0;
  }, []);

  // Handle domain textarea change
  const handleDomainsChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setCustomDomains(value);
    validateDomainsLocally(value);
  };

  // Test DNS resolution
  const handleTestDomains = async () => {
    const domains = customDomains
      .split("\n")
      .map((d) => d.trim())
      .filter((d) => d.length > 0);

    if (domains.length === 0) return;

    setIsTesting(true);
    setTestResults(null);
    try {
      const results = await backend.testDomainResolution(domains);
      setTestResults(results);
    } catch (err) {
      console.error("[NetworkWhitelistDialog] Failed to test domains:", err);
    } finally {
      setIsTesting(false);
    }
  };

  // Save changes
  const handleSave = async () => {
    const domains = useGlobalDefaults
      ? undefined // Use null/undefined to indicate "use global defaults"
      : customDomains
          .split("\n")
          .map((d) => d.trim())
          .filter((d) => d.length > 0);

    setIsSaving(true);
    try {
      // If using global defaults, pass empty array to clear custom domains
      // Otherwise pass the custom domains
      const domainsToSave = useGlobalDefaults ? [] : (domains || []);
      const updated = await backend.updateEnvironmentAllowedDomains(
        environment.id,
        domainsToSave
      );
      onUpdate(updated);
      onOpenChange(false);
    } catch (err) {
      console.error("[NetworkWhitelistDialog] Failed to save:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const isFullAccess = (environment.networkAccessMode ?? "restricted") === "full";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isFullAccess ? (
              <>
                <Globe className="h-5 w-5" />
                Network Settings
              </>
            ) : (
              <>
                <Shield className="h-5 w-5" />
                Network Whitelist
              </>
            )}
          </DialogTitle>
          <DialogDescription>
            {environment.name}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          {/* Network mode indicator */}
          <div className="flex items-center gap-2 p-3 rounded-md bg-muted border border-input">
            {isFullAccess ? (
              <>
                <Globe className="h-4 w-4 text-blue-500" />
                <div>
                  <div className="font-medium text-sm">Full Network Access</div>
                  <div className="text-xs text-muted-foreground">
                    This environment has unrestricted internet access. Whitelist settings do not apply.
                  </div>
                </div>
              </>
            ) : (
              <>
                <Shield className="h-4 w-4 text-green-500" />
                <div>
                  <div className="font-medium text-sm">Restricted Network Access</div>
                  <div className="text-xs text-muted-foreground">
                    Only whitelisted domains are accessible from this environment.
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Only show whitelist controls for restricted mode */}
          {!isFullAccess && (
            <>
              {/* Global defaults toggle */}
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Use Global Defaults</Label>
                  <p className="text-xs text-muted-foreground">
                    Use the default allowed domains from global settings
                  </p>
                </div>
                <Switch
                  checked={useGlobalDefaults}
                  onCheckedChange={setUseGlobalDefaults}
                />
              </div>

              {/* Custom domains textarea */}
              <div className="space-y-2">
                <Label>Allowed Domains</Label>
                <Textarea
                  value={customDomains}
                  onChange={handleDomainsChange}
                  disabled={useGlobalDefaults}
                  placeholder={"github.com\nregistry.npmjs.org\napi.anthropic.com"}
                  rows={8}
                  className={`font-mono text-sm ${
                    domainErrors.length > 0 ? "border-red-500" : ""
                  } ${useGlobalDefaults ? "opacity-50" : ""}`}
                />
              </div>

              {/* Validation errors */}
              {domainErrors.length > 0 && (
                <div className="text-sm text-red-500 space-y-1">
                  {domainErrors.map((error, i) => (
                    <div key={i} className="flex items-center gap-1">
                      <XCircle className="h-3 w-3" />
                      {error}
                    </div>
                  ))}
                </div>
              )}

              {/* Test button */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleTestDomains}
                disabled={isTesting || domainErrors.length > 0 || useGlobalDefaults}
              >
                {isTesting ? (
                  <>
                    <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                    Testing...
                  </>
                ) : (
                  "Test DNS Resolution"
                )}
              </Button>

              {/* Test results */}
              {testResults && (
                <div className="border rounded-md p-3 space-y-2 text-sm max-h-40 overflow-y-auto">
                  <div className="font-medium">DNS Test Results:</div>
                  {testResults.map((result, i) => (
                    <div key={i} className="flex items-start gap-2">
                      {result.resolvable ? (
                        <CheckCircle2 className="h-4 w-4 text-green-500 mt-0.5 shrink-0" />
                      ) : result.valid ? (
                        <AlertCircle className="h-4 w-4 text-yellow-500 mt-0.5 shrink-0" />
                      ) : (
                        <XCircle className="h-4 w-4 text-red-500 mt-0.5 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <span className="font-mono text-xs break-all">{result.domain}</span>
                        {result.error && (
                          <span className="text-red-500 text-xs block">{result.error}</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Running container note */}
              {environment.status === "running" && (
                <p className="text-xs text-muted-foreground">
                  Changes will be applied to the running container immediately.
                </p>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          {!isFullAccess && (
            <Button
              onClick={handleSave}
              disabled={isSaving || domainErrors.length > 0}
            >
              {isSaving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
