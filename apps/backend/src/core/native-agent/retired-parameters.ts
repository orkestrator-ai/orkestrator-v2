/**
 * Parameter values a session record can still hold but nothing may act on.
 *
 * `permissionMode` was a Claude parameter value before approval modes
 * (`controls.approvalMode`) replaced it. `summary` was a Codex reasoning
 * summary choice the backend's catalogue offered but the Codex bridge never
 * applied. No descriptor offers either any more, so control updates drop them
 * and bridge requests never forward them; a bridge that received one would
 * ignore it anyway.
 *
 * `permissionMode` is retired on every platform, as it was before this list
 * was keyed. Every other entry is retired only on its own platform, because
 * the same id can be a live parameter elsewhere (an ACP config option, say).
 */
export const RETIRED_PERMISSION_MODE_PARAMETER = "permissionMode";

const RETIRED_PLATFORM_PARAMETERS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  codex: Object.freeze(["summary"]),
});

/** True when `parameterId` is a retired value for `platform`. */
export function isRetiredParameter(platform: string, parameterId: string): boolean {
  return (
    parameterId === RETIRED_PERMISSION_MODE_PARAMETER ||
    RETIRED_PLATFORM_PARAMETERS[platform]?.includes(parameterId) === true
  );
}

/** `values` without retired entries, or undefined when nothing is left. */
export function withoutRetiredParameterValues(
  platform: string,
  values: Record<string, string | boolean> | undefined,
): Record<string, string | boolean> | undefined {
  if (!values || !Object.keys(values).some((id) => isRetiredParameter(platform, id))) {
    return values;
  }
  const rest = Object.fromEntries(
    Object.entries(values).filter(([id]) => !isRetiredParameter(platform, id)),
  );
  return Object.keys(rest).length > 0 ? rest : undefined;
}
