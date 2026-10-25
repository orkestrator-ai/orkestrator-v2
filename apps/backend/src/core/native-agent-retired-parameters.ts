/**
 * Parameter values a session record can still hold but nothing may act on.
 *
 * `permissionMode` was a Claude parameter value before approval modes
 * (`controls.approvalMode`) replaced it. No descriptor offers it, so control
 * updates drop it and prompts never forward it; a bridge that received it
 * would ignore it anyway.
 */
export const RETIRED_PERMISSION_MODE_PARAMETER = "permissionMode";

/** `values` without retired entries, or undefined when nothing is left. */
export function withoutRetiredParameterValues(
  values: Record<string, string | boolean> | undefined,
): Record<string, string | boolean> | undefined {
  if (!values || !Object.hasOwn(values, RETIRED_PERMISSION_MODE_PARAMETER)) return values;
  const rest = Object.fromEntries(
    Object.entries(values).filter(([id]) => id !== RETIRED_PERMISSION_MODE_PARAMETER),
  );
  return Object.keys(rest).length > 0 ? rest : undefined;
}
