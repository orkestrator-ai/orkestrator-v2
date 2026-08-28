export const LEGACY_TIMESTAMP_ENVIRONMENT_NAME = /^\d{8}-\d{6}$/;
export const COMPACT_TIMESTAMP_ENVIRONMENT_NAME = /^\d{15}$/;

/**
 * True while an environment still carries its generated, pre-prompt name.
 *
 * This is a backend lifecycle decision: every prompt entry point uses the same
 * predicate before it records durable naming intent.
 */
export function isGeneratedEnvironmentName(name: string): boolean {
  return (
    LEGACY_TIMESTAMP_ENVIRONMENT_NAME.test(name) || COMPACT_TIMESTAMP_ENVIRONMENT_NAME.test(name)
  );
}
