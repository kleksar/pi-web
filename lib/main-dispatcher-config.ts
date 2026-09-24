import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { readBoundedRegularFile } from "./bounded-file";
import { getRepositoryRosterRoot } from "./repository-roster";
import { ORCHESTRATION_MAIN_ROLE } from "./subagents";

export interface MainDispatcherConfig {
  model: string;
  thinking: ThinkingLevel;
  fastMode: boolean;
  additionalInstructions: string;
}

export class MainDispatcherConfigConflictError extends Error {
  constructor() {
    super("Main dispatcher configuration changed; reload before saving");
  }
}

const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_INSTRUCTIONS_BYTES = 16 * 1024;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_MAIN_DISPATCHER_CONFIG: MainDispatcherConfig = {
  model: ORCHESTRATION_MAIN_ROLE.model,
  thinking: ORCHESTRATION_MAIN_ROLE.thinking,
  fastMode: ORCHESTRATION_MAIN_ROLE.fastMode,
  additionalInstructions: "",
};

export function validateMainDispatcherConfig(value: unknown): MainDispatcherConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Main dispatcher configuration must be an object");
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (keys.some((key) => !["model", "thinking", "fastMode", "additionalInstructions"].includes(key))) {
    throw new Error("Unknown Main dispatcher configuration field");
  }
  if (typeof input.model !== "string" || input.model.length > 256
    || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:/-]+$/.test(input.model)) {
    throw new Error("Main dispatcher model must be provider/model-id");
  }
  if (typeof input.thinking !== "string" || !THINKING_LEVELS.has(input.thinking as ThinkingLevel)) {
    throw new Error("Unsupported Main dispatcher thinking level");
  }
  if (typeof input.fastMode !== "boolean") throw new Error("Main dispatcher Fast must be a boolean");
  if (typeof input.additionalInstructions !== "string"
    || Buffer.byteLength(input.additionalInstructions, "utf8") > MAX_INSTRUCTIONS_BYTES) {
    throw new Error("Main dispatcher instructions must be at most 16 KiB");
  }
  return {
    model: input.model,
    thinking: input.thinking as ThinkingLevel,
    fastMode: input.fastMode,
    additionalInstructions: input.additionalInstructions,
  };
}

export function getMainDispatcherConfigPath(): string | null {
  const root = getRepositoryRosterRoot();
  return root ? join(root, "main-dispatcher.json") : null;
}

function readConfigBytes(path: string): Buffer | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) {
    throw new Error("Main dispatcher configuration must be a regular file smaller than 64 KiB");
  }
  return readBoundedRegularFile(path, MAX_CONFIG_BYTES, "Main dispatcher configuration");
}

export function readMainDispatcherConfig(path = getMainDispatcherConfigPath()): {
  config: MainDispatcherConfig; revision: string; path: string | null; basePrompt: string;
} {
  const bytes = path ? readConfigBytes(path) : null;
  let config = DEFAULT_MAIN_DISPATCHER_CONFIG;
  if (bytes) {
    const data: unknown = JSON.parse(bytes.toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data) || (data as Record<string, unknown>).version !== 1) {
      throw new Error("Unsupported Main dispatcher configuration version");
    }
    config = validateMainDispatcherConfig((data as Record<string, unknown>).config);
  }
  return {
    config,
    revision: bytes ? createHash("sha256").update(bytes).digest("hex") : "absent",
    path,
    basePrompt: ORCHESTRATION_MAIN_ROLE.systemPrompt,
  };
}

/** Only the server chooses the repository path. Never accept a caller-supplied path from HTTP. */
export function saveMainDispatcherConfig(
  value: unknown, expectedRevision: string, path = getMainDispatcherConfigPath(),
): ReturnType<typeof readMainDispatcherConfig> {
  if (!path) throw new Error("Repository roster is unavailable");
  const next = validateMainDispatcherConfig(value);
  const release = lockfile.lockSync(path, { realpath: false, stale: 10_000 });
  try {
    const previous = readMainDispatcherConfig(path);
    if (previous.revision !== expectedRevision) throw new MainDispatcherConfigConflictError();
    writePrivateFileAtomicSync(path, `${JSON.stringify({ version: 1, config: next }, null, 2)}\n`);
    return readMainDispatcherConfig(path);
  } finally {
    release();
  }
}

export function mainDispatcherPrompt(config: MainDispatcherConfig): string {
  return config.additionalInstructions
    ? `${ORCHESTRATION_MAIN_ROLE.systemPrompt}\n\nAdditional operator instructions:\n${config.additionalInstructions}`
    : ORCHESTRATION_MAIN_ROLE.systemPrompt;
}
