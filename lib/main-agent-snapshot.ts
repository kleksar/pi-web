import {
  validatePinnedSkills,
  validatePinnedExtensionTools,
  type PinnedSkill,
  type PinnedExtensionTool,
} from "./agent-resource-selection";
import { validateMainAgentConfig } from "./main-agent-config";
import type { SubagentChildProfileFingerprint } from "./subagents";
import type { SessionEntry } from "./types";

export const MAIN_RESOURCE_META_TYPE = "pi-web:main-resources";

export interface MainSessionResources {
  version: 1;
  selectedSkills?: PinnedSkill[];
  selectedExtensionTools?: PinnedExtensionTool[];
  orchestration?: {
    allowedChildren: string[];
    dependencies?: Record<string, string[]>;
    contextProviders?: Record<string, string[]>;
    childProfiles: Record<string, SubagentChildProfileFingerprint>;
  };
}

/** Invalid persisted policy blocks reopening instead of restoring legacy unrestricted Main. */
export function readMainSessionResources(entries: readonly SessionEntry[]): MainSessionResources | null {
  const marker = entries.find((entry) => entry.type === "custom" && entry.customType === MAIN_RESOURCE_META_TYPE);
  if (!marker) return null;
  if (marker.type !== "custom" || !marker.data || typeof marker.data !== "object" || Array.isArray(marker.data)) {
    throw new Error("Invalid Main resource snapshot");
  }
  const data = marker.data as Record<string, unknown>;
  if (data.version !== 1) throw new Error("Invalid Main resource snapshot version");
  const selectedSkills = data.selectedSkills === undefined ? undefined : validatePinnedSkills(data.selectedSkills);
  const selectedExtensionTools = data.selectedExtensionTools === undefined
    ? undefined : validatePinnedExtensionTools(data.selectedExtensionTools);
  let orchestration: MainSessionResources["orchestration"];
  if (data.orchestration !== undefined) {
    if (!data.orchestration || typeof data.orchestration !== "object" || Array.isArray(data.orchestration)) {
      throw new Error("Invalid Main orchestration snapshot");
    }
    const record = data.orchestration as Record<string, unknown>;
    const validated = validateMainAgentConfig({ orchestration: record }).orchestration;
    const pins = record.childProfiles;
    if (!validated || !pins || typeof pins !== "object" || Array.isArray(pins)) {
      throw new Error("Invalid Main orchestration snapshot");
    }
    const childProfiles: Record<string, SubagentChildProfileFingerprint> = {};
    const rawPins = pins as Record<string, unknown>;
    const wanted = validated.allowedChildren.map((name) => name.toLowerCase());
    if (Object.keys(rawPins).length !== wanted.length || Object.keys(rawPins).some((name) => !wanted.includes(name))) {
      throw new Error("Invalid Main child profile snapshot");
    }
    for (const child of wanted) {
      const pin = rawPins[child];
      if (!pin || typeof pin !== "object" || Array.isArray(pin)) throw new Error("Invalid Main child profile snapshot");
      const fields = pin as Record<string, unknown>;
      if (!["builtin", "global", "workspace", "project"].includes(fields.scope as string)
        || typeof fields.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(fields.sha256)
        || (fields.scope !== "builtin" && (typeof fields.filePath !== "string" || !fields.filePath))) {
        throw new Error("Invalid Main child profile snapshot");
      }
      childProfiles[child] = fields as unknown as SubagentChildProfileFingerprint;
    }
    orchestration = {
      allowedChildren: validated.allowedChildren,
      ...(validated.dependencies !== undefined ? { dependencies: validated.dependencies } : {}),
      ...(validated.contextProviders !== undefined ? { contextProviders: validated.contextProviders } : {}),
      childProfiles,
    };
  }
  return {
    version: 1,
    ...(selectedSkills !== undefined ? { selectedSkills } : {}),
    ...(selectedExtensionTools !== undefined ? { selectedExtensionTools } : {}),
    ...(orchestration !== undefined ? { orchestration } : {}),
  };
}
