import { existsSync, statSync } from "node:fs";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { portableSelectedSkillReferences, validateSelectedAgentResources } from "@/lib/agent-resource-selection";
import {
  changedProjectMainOverrides,
  getMainAgentConfigRevision,
  getRosterMainAgentConfigPath,
  MainAgentConfigConflictError,
  readMainAgentConfig,
  readEffectiveMainAgentConfig,
  readEffectiveGlobalMainAgentConfig,
  readRosterMainAgentConfig,
  saveMainAgentConfig,
  saveProjectMainAgentConfig,
  validateMainAgentConfig,
} from "@/lib/main-agent-config";
import { getRepositoryRosterRoot } from "@/lib/repository-roster";
import { listSubagentProfiles } from "@/lib/subagents";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

async function validateCwd(value: unknown): Promise<string> {
  if (typeof value !== "string" || !value || !existsSync(value) || !statSync(value).isDirectory()) {
    throw new Error("Valid cwd required");
  }
  if (!isExistingFilePathAllowed(value, await getAllowedFileRoots())) throw new Error("Access denied");
  return value;
}

function validateChildren(cwd: string, names: string[] | undefined): void {
  if (!names) return;
  const effective = new Map(listSubagentProfiles(cwd)
    .filter((profile) => profile.enabled && !profile.configurationError)
    .map((profile) => [profile.name.toLowerCase(), profile.name]));
  for (const name of names) {
    if (!effective.has(name.toLowerCase())) throw new Error(`Allowed child agent is missing or disabled: ${name}`);
  }
}

function errorResponse(cause: unknown): NextResponse {
  const message = cause instanceof Error ? cause.message : String(cause);
  return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const cwd = await validateCwd(url.searchParams.get("cwd"));
    if (url.searchParams.get("scope") === "project") {
      return NextResponse.json(readEffectiveMainAgentConfig(cwd));
    }
    if (url.searchParams.get("scope") === "global") {
      return NextResponse.json(readEffectiveGlobalMainAgentConfig());
    }
    if (url.searchParams.get("scope") === "roster") {
      const path = getRosterMainAgentConfigPath();
      if (!path) throw new Error("Repository roster is not enabled");
      return NextResponse.json({ config: readRosterMainAgentConfig(), revision: getMainAgentConfigRevision(path), rosterPath: path });
    }
    if (url.searchParams.has("scope")) throw new Error("Unknown Main configuration scope");
    return NextResponse.json({ config: readMainAgentConfig(), revision: getMainAgentConfigRevision() });
  } catch (cause) {
    return errorResponse(cause);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });

  try {
    const body = await req.json() as {
      cwd?: unknown; config?: unknown; expectedRevision?: unknown;
      scope?: unknown; previous?: unknown; overrides?: unknown;
    };
    const cwd = await validateCwd(body.cwd);
    if (typeof body.expectedRevision !== "string") {
      return NextResponse.json({ error: "expectedRevision is required" }, { status: 400 });
    }
    const config = validateMainAgentConfig(body.config);
    if (body.scope === "roster") {
      const root = getRepositoryRosterRoot();
      const path = getRosterMainAgentConfigPath();
      if (!root || !path) throw new Error("Repository roster is not enabled");
      validateChildren(cwd, config.orchestration?.allowedChildren);
      await validateSelectedAgentResources(cwd, config);
      if (config.selectedExtensionTools?.length) {
        throw new Error("Repository roster extension tools must be configured globally");
      }
      const portable = config.selectedSkills === undefined ? config : {
        ...config, selectedSkills: portableSelectedSkillReferences(root, config.selectedSkills, "skills"),
      };
      if (portable.selectedSkills?.some((item) => item.startsWith("/") || /^[A-Za-z]:[\\/]/.test(item))) {
        throw new Error("Repository roster skill paths must be relative to orchestration/skills");
      }
      const saved = await saveMainAgentConfig(portable, body.expectedRevision as string, path);
      return NextResponse.json({ config: readRosterMainAgentConfig(), revision: saved.revision, rosterPath: path });
    }
    if (body.scope === "global") {
      const current = readEffectiveGlobalMainAgentConfig();
      if (current.revision !== body.expectedRevision) throw new MainAgentConfigConflictError();
      const previous = validateMainAgentConfig(body.previous);
      const overrides = validateMainAgentConfig(body.overrides);
      if (JSON.stringify(previous) !== JSON.stringify(current.config)
        || JSON.stringify(overrides) !== JSON.stringify(current.overrides)) {
        throw new MainAgentConfigConflictError();
      }
      const next = changedProjectMainOverrides(previous, config, overrides, current.globalConfig);
      const effective = { ...current.globalConfig, ...next };
      validateChildren(cwd, effective.orchestration?.allowedChildren);
      await validateSelectedAgentResources(cwd, effective);
      await saveMainAgentConfig(next, getMainAgentConfigRevision());
      return NextResponse.json(readEffectiveGlobalMainAgentConfig());
    }
    if (body.scope === "project") {
      const current = readEffectiveMainAgentConfig(cwd);
      if (!current.trusted) {
        throw new Error("Trust this project before editing its Main configuration");
      }
      if (current.revision !== body.expectedRevision) throw new MainAgentConfigConflictError();
      const previous = validateMainAgentConfig(body.previous);
      const overrides = validateMainAgentConfig(body.overrides);
      // Project saves may only change the project overlay that the editor actually loaded.
      if (JSON.stringify(previous) !== JSON.stringify(current.config)
        || JSON.stringify(overrides) !== JSON.stringify(current.overrides)) {
        throw new MainAgentConfigConflictError();
      }
      const next = changedProjectMainOverrides(previous, config, overrides, current.globalConfig);
      validateChildren(cwd, next.orchestration?.allowedChildren);
      await validateSelectedAgentResources(cwd, {
        selectedSkills: next.selectedSkills,
        selectedExtensionTools: next.selectedExtensionTools,
      });
      if (next.selectedExtensionTools?.length) {
        throw new Error("Project Main configuration supports only an empty extension tool override; configure shared tools globally");
      }
      const portable = next.selectedSkills === undefined ? next : {
        ...next,
        selectedSkills: portableSelectedSkillReferences(cwd, next.selectedSkills, ".pi/skills"),
      };
      if (portable.selectedSkills?.some((path) => path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path))) {
        throw new Error("Project Main skills must use repository-relative paths");
      }
      const saved = await saveProjectMainAgentConfig(cwd, portable, body.expectedRevision);
      return NextResponse.json(saved);
    }
    if (body.scope !== undefined) throw new Error("Unknown Main configuration scope");
    validateChildren(cwd, config.orchestration?.allowedChildren);
    await validateSelectedAgentResources(cwd, config);
    // Other editors may have saved the global config while catalog discovery was in progress.
    const saved = await saveMainAgentConfig(config, body.expectedRevision);
    return NextResponse.json(saved);
  } catch (cause) {
    if (cause instanceof MainAgentConfigConflictError) {
      return NextResponse.json({ error: cause.message, code: "conflict" }, { status: 409 });
    }
    return errorResponse(cause);
  }
}
