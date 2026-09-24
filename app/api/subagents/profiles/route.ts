import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  deleteSubagentProfile,
  listSubagentProfileSources,
  isOrchestrationSubagentProfile,
  isCoreSubagentProfile,
  saveSubagentProfile,
  type SubagentProfile,
  type SubagentWritableScope,
} from "@/lib/subagents";
import { disabledBuiltInSubagents, getRepositorySubagentSettingsPath, getSubagentSettingsPath, readSubagentSettingsSources, writeDisabledBuiltInSubagent } from "@/lib/subagent-settings";
import { getRepositoryRosterRoot } from "@/lib/repository-roster";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

function rejectedMutation(req: Request): NextResponse | null {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  return null;
}

async function validateCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd || !existsSync(cwd)) throw new Error("Valid cwd required");
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new Error("Access denied");
  return cwd;
}

function validateScope(scope: unknown): SubagentWritableScope {
  if (scope !== "roster" && scope !== "global" && scope !== "project") throw new Error("scope must be roster, global, or project");
  return scope;
}

/** A built-in has no file to save or delete, but its switch is persisted all the same. */
function validateToggleScope(scope: unknown): SubagentWritableScope | "builtin" {
  if (scope === "builtin") return scope;
  if (scope !== "roster" && scope !== "global" && scope !== "project") throw new Error("scope must be roster, global, project, or builtin");
  return scope;
}

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const cwd = await validateCwd(params.get("cwd"));
    const orchestration = params.get("orchestration");
    if (orchestration !== null && orchestration !== "1") throw new Error("orchestration must be 1");
    const profiles = listSubagentProfileSources(cwd, { orchestrationEnabled: orchestration === "1" });
    const rosterRoot = getRepositoryRosterRoot();
    const coreProfileNames = profiles.filter((item) => isCoreSubagentProfile(item.name)).map((item) => item.name);
    if (orchestration !== "1") return NextResponse.json({ profiles, coreProfileNames, rosterAvailable: Boolean(rosterRoot), ...(rosterRoot ? { rosterRoot } : {}) });
    return NextResponse.json({ profiles,
      coreProfileNames,
      orchestrationProfileNames: profiles.filter((item) => isOrchestrationSubagentProfile(item.name)).map((item) => item.name),
      rosterAvailable: Boolean(rosterRoot), ...(rosterRoot ? { rosterRoot } : {}),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function PUT(req: Request) {
  const rejected = rejectedMutation(req);
  if (rejected) return rejected;
  try {
    const body = await req.json() as {
      cwd?: unknown;
      scope?: unknown;
      profile?: Omit<SubagentProfile, "scope" | "filePath">;
    };
    const cwd = await validateCwd(body.cwd);
    const scope = validateScope(body.scope);
    if (!body.profile || typeof body.profile.name !== "string") {
      return NextResponse.json({ error: "profile required" }, { status: 400 });
    }
    return NextResponse.json({ profile: saveSubagentProfile(cwd, scope, body.profile) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function PATCH(req: Request) {
  const rejected = rejectedMutation(req);
  if (rejected) return rejected;
  try {
    const body = await req.json() as { cwd?: unknown; scope?: unknown; name?: unknown; enabled?: unknown; orchestration?: unknown; settingsScope?: unknown };
    if (body.orchestration !== undefined && typeof body.orchestration !== "boolean") throw new Error("orchestration must be a boolean");
    if (body.settingsScope !== undefined && body.settingsScope !== "roster" && body.settingsScope !== "local") {
      throw new Error("settingsScope must be roster or local");
    }
    const cwd = await validateCwd(body.cwd);
    const scope = validateToggleScope(body.scope);
    if (typeof body.name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });
    if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled required" }, { status: 400 });
    const name = body.name;
    const source = listSubagentProfileSources(cwd, { orchestrationEnabled: body.orchestration === true }).find((profile) =>
      profile.scope === scope && profile.name.toLowerCase() === name.toLowerCase()
    );
    if (!source) return NextResponse.json({ error: "Agent profile not found" }, { status: 404 });
    if (scope === "builtin") {
      const repoPath = getRepositorySubagentSettingsPath();
      const settingsScope = body.settingsScope ?? (repoPath ? "roster" : "local");
      if (settingsScope === "roster" && !repoPath) throw new Error("Repository roster is unavailable");
      writeDisabledBuiltInSubagent(source.name, !body.enabled,
        settingsScope === "roster" ? repoPath! : getSubagentSettingsPath());
      return NextResponse.json({
        profile: { ...source, enabled: !disabledBuiltInSubagents().has(source.name.toLowerCase()) },
        source: readSubagentSettingsSources().disabledBuiltIns,
        savedScope: settingsScope,
      });
    }
    const profile: Omit<SubagentProfile, "scope" | "filePath"> = {
      name: source.name,
      displayName: source.displayName,
      description: source.description,
      systemPrompt: source.systemPrompt,
      tools: source.tools,
      extensionTools: source.extensionTools,
      fastMode: source.fastMode,
      allowedSubagents: source.allowedSubagents,
      color: source.color,
      isolation: source.isolation,
      persistSession: source.persistSession,
      loadSkills: source.loadSkills,
      loadExtensions: source.loadExtensions,
      promptMode: source.promptMode,
      model: source.model,
      thinking: source.thinking,
      maxTurns: source.maxTurns,
      inheritContext: source.inheritContext,
      runInBackground: source.runInBackground,
      enabled: source.enabled,
    };
    return NextResponse.json({ profile: saveSubagentProfile(cwd, scope, { ...profile, enabled: body.enabled }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function DELETE(req: Request) {
  const rejected = rejectedMutation(req);
  if (rejected) return rejected;
  try {
    const body = await req.json() as { cwd?: unknown; scope?: unknown; name?: unknown };
    const cwd = await validateCwd(body.cwd);
    const scope = validateScope(body.scope);
    if (typeof body.name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });
    deleteSubagentProfile(cwd, scope, body.name);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}
