/**
 * The `dev-test.ts` arguments that bring an agent-test profile back with the
 * selection it was started with, read from its `profile.json`. Specs that
 * stop and restart a profile mid-run use this, never their own copy.
 *
 * `profile.json` records a credential-free profile (`--no-agent-credentials`)
 * as `credentialSources: []`, and the launcher reads "no credential flag" as
 * "every host credential". Passing nothing for an empty list would therefore
 * restart a credential-free profile with the host's logins, so an empty list
 * becomes `--no-agent-credentials`. A record with no list at all (an older
 * profile) keeps the launcher's default, as it was started.
 */
export type StoredProfileSelection = {
  credentialSources?: readonly string[];
  agentPlatforms?: readonly string[];
};

export function devTestRestartArgs(profile: string, stored: StoredProfileSelection): string[] {
  const sources = stored.credentialSources;
  return [
    "apps/desktop/scripts/dev-test.ts",
    "--profile",
    profile,
    ...(sources === undefined
      ? []
      : sources.length === 0
        ? ["--no-agent-credentials"]
        : sources.flatMap((source) => ["--credential-source", source])),
    ...(stored.agentPlatforms?.length
      ? ["--agent-platforms", stored.agentPlatforms.join(",")]
      : []),
  ];
}
