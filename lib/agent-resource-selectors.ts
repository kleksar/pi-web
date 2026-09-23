import type { SelectedExtensionTool } from "./agent-resource-selection";

export function extensionToolKey(ref: SelectedExtensionTool): string {
  return JSON.stringify([ref.extensionPath, ref.toolName]);
}

export function toggleSelectedSkill(current: readonly string[], filePath: string): string[] {
  return current.includes(filePath)
    ? current.filter((path) => path !== filePath)
    : [...current, filePath];
}

export function toggleSelectedExtensionTool(
  current: readonly SelectedExtensionTool[],
  ref: SelectedExtensionTool,
): SelectedExtensionTool[] {
  const key = extensionToolKey(ref);
  return current.some((tool) => extensionToolKey(tool) === key)
    ? current.filter((tool) => extensionToolKey(tool) !== key)
    : [...current, ref];
}

/** Switching a legacy load-all profile to explicit selection must not silently drop its current resources. */
export function explicitSkillSelection(
  selected: readonly string[] | undefined,
  available: readonly { filePath: string; unavailableReason?: string }[],
  legacyLoadAll: boolean,
): string[] {
  if (selected) return [...selected];
  return legacyLoadAll ? [...new Set(available.filter((skill) => !skill.unavailableReason).map((skill) => skill.filePath))] : [];
}

export function explicitExtensionToolSelection(
  selected: readonly SelectedExtensionTool[] | undefined,
  available: readonly (SelectedExtensionTool & { unavailableReason?: string })[],
  legacyLoadAll: boolean,
): SelectedExtensionTool[] {
  if (selected) return [...selected];
  if (!legacyLoadAll) return [];
  const found = new Set<string>();
  return available.filter((tool) => !tool.unavailableReason).flatMap((tool) => {
    const key = extensionToolKey(tool);
    if (found.has(key)) return [];
    found.add(key);
    return [{ extensionPath: tool.extensionPath, toolName: tool.toolName }];
  });
}

export function missingSelectedSkills(
  selected: readonly string[],
  available: readonly { filePath: string }[],
): string[] {
  const known = new Set(available.map((skill) => skill.filePath));
  return selected.filter((path) => !known.has(path));
}

export function missingSelectedExtensionTools(
  selected: readonly SelectedExtensionTool[],
  available: readonly SelectedExtensionTool[],
): SelectedExtensionTool[] {
  const known = new Set(available.map(extensionToolKey));
  return selected.filter((ref) => !known.has(extensionToolKey(ref)));
}

export function matchesResourceSearch(query: string, ...fields: Array<string | undefined>): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || fields.some((value) => value?.toLocaleLowerCase().includes(needle));
}
