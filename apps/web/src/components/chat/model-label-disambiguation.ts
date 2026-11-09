import type { AgentModel } from "@orkestrator/protocol/native-agent";

/**
 * A display label's identity for look-alike checks: case, spacing and
 * punctuation do not tell two models apart to a reader ("Beam Free" and
 * "beam-free" read as the same model).
 */
function lookAlikeKey(label: string): string {
  return label.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The provider to show beside `model`'s name when another model of the same
 * platform in `models` reads the same but comes from a different provider, so
 * the user can tell which one is selected. `undefined` when the name alone is
 * unambiguous or the model names no provider.
 */
export function disambiguatingProviderLabel(
  model: AgentModel | undefined,
  models: readonly AgentModel[],
): string | undefined {
  const provider = model?.providerLabel;
  if (!model || !provider) return undefined;
  const key = lookAlikeKey(model.label);
  if (!key) return undefined;
  const lookAlike = models.some(
    (other) =>
      other.platform === model.platform &&
      other.id !== model.id &&
      other.providerLabel !== provider &&
      lookAlikeKey(other.label) === key,
  );
  return lookAlike ? provider : undefined;
}
