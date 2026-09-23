import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import type { SelectedExtensionTool } from "./agent-resource-selection";
import { MAX_SUBAGENT_DEPENDENCIES, type SubagentOrchestration } from "./subagents";

/** Missing fields preserve Pi's current discovery of resources and child agents. */
export interface MainAgentConfig {
  selectedSkills?: string[];
  selectedExtensionTools?: SelectedExtensionTool[];
  orchestration?: SubagentOrchestration | null;
}

const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function uniqueStrings(value: unknown, label: string, profileNames = false): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be a list`);
  const seen = new Set<string>();
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim() || entry !== entry.trim()
      || (profileNames && !PROFILE_NAME_RE.test(entry))) {
      throw new Error(`${label} contains an invalid value`);
    }
    const key = profileNames ? entry.toLowerCase() : entry;
    if (seen.has(key)) throw new Error(`${label} contains duplicate values`);
    seen.add(key);
    return entry;
  });
}

function parseDependencies(value: unknown, allowedChildren: readonly string[], label = "Main dependencies"): Record<string, string[]> {
  if (!record(value)) throw new Error(`${label} must be an object`);
  const known = new Map(allowedChildren.map((name) => [name.toLowerCase(), name]));
  const dependencies: Record<string, string[]> = Object.create(null);
  const seen = new Set<string>();
  for (const [rawConsumer, rawProducers] of Object.entries(value)) {
    const consumer = known.get(rawConsumer.toLowerCase());
    if (!consumer || seen.has(consumer.toLowerCase())) throw new Error(`${label} must name allowed child agents`);
    seen.add(consumer.toLowerCase());
    const producers = uniqueStrings(rawProducers, `${label} for ${consumer}`, true);
    if (producers.length > MAX_SUBAGENT_DEPENDENCIES) {
      throw new Error(`${label} can have at most ${MAX_SUBAGENT_DEPENDENCIES} agents per child`);
    }
    dependencies[consumer] = producers.map((producer) => {
      const knownProducer = known.get(producer.toLowerCase());
      if (!knownProducer || knownProducer === consumer) throw new Error(`${label} must refer to other allowed children`);
      return knownProducer;
    });
  }

  const remaining = new Map(allowedChildren.map((name) => [name, dependencies[name]?.length ?? 0]));
  const consumers = new Map(allowedChildren.map((name) => [name, [] as string[]]));
  for (const [consumer, producers] of Object.entries(dependencies)) {
    for (const producer of producers) consumers.get(producer)?.push(consumer);
  }
  const ready = allowedChildren.filter((name) => remaining.get(name) === 0);
  let visited = 0;
  while (ready.length) {
    const producer = ready.pop()!;
    visited++;
    for (const consumer of consumers.get(producer) ?? []) {
      const next = (remaining.get(consumer) ?? 0) - 1;
      remaining.set(consumer, next);
      if (next === 0) ready.push(consumer);
    }
  }
  if (visited !== allowedChildren.length) throw new Error(`${label} contain a cycle`);
  return dependencies;
}

/** Parse strictly. A damaged file must never turn restrictions into legacy unrestricted access. */
export function validateMainAgentConfig(value: unknown): MainAgentConfig {
  if (!record(value)) throw new Error("Main configuration must be an object");
  if (value.version !== undefined && value.version !== 1) throw new Error("Unsupported Main configuration version");
  const config: MainAgentConfig = {};
  if (Object.hasOwn(value, "selectedSkills")) {
    config.selectedSkills = uniqueStrings(value.selectedSkills, "Selected skills");
  }
  if (Object.hasOwn(value, "selectedExtensionTools")) {
    if (!Array.isArray(value.selectedExtensionTools)) throw new Error("Selected extension tools must be a list");
    const seen = new Set<string>();
    config.selectedExtensionTools = value.selectedExtensionTools.map((entry) => {
      if (!record(entry) || typeof entry.extensionPath !== "string" || !entry.extensionPath.trim()
        || entry.extensionPath !== entry.extensionPath.trim() || typeof entry.toolName !== "string"
        || !entry.toolName.trim() || entry.toolName !== entry.toolName.trim()) {
        throw new Error("Selected extension tool must have an extension path and tool name");
      }
      const ref = { extensionPath: entry.extensionPath, toolName: entry.toolName };
      const key = JSON.stringify([ref.extensionPath, ref.toolName]);
      if (seen.has(key)) throw new Error("Selected extension tools contain duplicate values");
      seen.add(key);
      return ref;
    });
  }
  if (Object.hasOwn(value, "orchestration")) {
    if (value.orchestration === null) {
      config.orchestration = null;
    } else {
      if (!record(value.orchestration)) throw new Error("Main orchestration must be an object or null");
      const children = uniqueStrings(value.orchestration.allowedChildren, "Allowed child agents", true);
      const dependencies = Object.hasOwn(value.orchestration, "dependencies")
        ? parseDependencies(value.orchestration.dependencies, children)
        : undefined;
      const contextProviders = Object.hasOwn(value.orchestration, "contextProviders")
        ? parseDependencies(value.orchestration.contextProviders, children, "Main on-demand context providers")
        : undefined;
      if (contextProviders) {
        const combined = Object.fromEntries(children.map((child) => [child,
          [...new Set([...(dependencies?.[child] ?? []), ...(contextProviders[child] ?? [])])]]));
        parseDependencies(combined, children, "Main combined orchestration links");
      }
      config.orchestration = {
        allowedChildren: children,
        ...(dependencies !== undefined ? { dependencies } : {}),
        ...(contextProviders !== undefined ? { contextProviders } : {}),
      };
    }
  }
  return config;
}

export function getMainAgentConfigPath(agentDir = getAgentDir()): string {
  return join(agentDir, "main-agent-config.json");
}

export function getMainAgentConfigRevision(configPath = getMainAgentConfigPath()): string {
  return existsSync(configPath)
    ? createHash("sha256").update(readFileSync(configPath)).digest("hex")
    : "absent";
}

export function readMainAgentConfig(configPath = getMainAgentConfigPath()): MainAgentConfig {
  if (!existsSync(configPath)) return {};
  return validateMainAgentConfig(JSON.parse(readFileSync(configPath, "utf8")) as unknown);
}

export function writeMainAgentConfig(
  input: MainAgentConfig,
  configPath = getMainAgentConfigPath(),
): MainAgentConfig {
  // Do not overwrite an invalid or future-versioned file with a partial UI draft.
  readMainAgentConfig(configPath);
  const config = validateMainAgentConfig(input);
  mkdirSync(dirname(configPath), { recursive: true });
  writePrivateFileAtomicSync(configPath, `${JSON.stringify({ version: 1, ...config }, null, 2)}\n`);
  return config;
}

export class MainAgentConfigConflictError extends Error {
  constructor() {
    super("Main configuration has changed. Reload and review your edits.");
    this.name = "MainAgentConfigConflictError";
  }
}

/** Compare and replace under one interprocess lock; callers cannot race a stale editor. */
export async function saveMainAgentConfig(
  input: MainAgentConfig,
  expectedRevision: string,
  configPath = getMainAgentConfigPath(),
): Promise<{ config: MainAgentConfig; revision: string }> {
  if (typeof expectedRevision !== "string" || !/^(absent|[0-9a-f]{64})$/.test(expectedRevision)) {
    throw new Error("A valid Main configuration revision is required");
  }
  const config = validateMainAgentConfig(input);
  const parent = dirname(configPath);
  mkdirSync(parent, { recursive: true });
  const release = await lockfile.lock(parent, { retries: { retries: 8, factor: 1, minTimeout: 20, maxTimeout: 100 } });
  try {
    // Read validation and the revision check happen under the same lock as the write.
    readMainAgentConfig(configPath);
    if (getMainAgentConfigRevision(configPath) !== expectedRevision) throw new MainAgentConfigConflictError();
    const saved = writeMainAgentConfig(config, configPath);
    return { config: saved, revision: getMainAgentConfigRevision(configPath) };
  } finally {
    await release();
  }
}
