import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  deleteSubagentProfile,
  listSubagentProfileSources,
  listSubagentProfiles,
  saveSubagentProfile,
  type SubagentProfileInput,
  type SubagentWritableScope,
} from "@/lib/subagents";
import {
  disabledBuiltInSubagents,
  getRepositorySubagentSettingsPath,
  getSubagentSettingsPath,
  readSubagentSettingsSources,
  writeDisabledBuiltInSubagent,
} from "@/lib/subagent-settings";
import { validateSelectedAgentResources } from "@/lib/agent-resource-selection";
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
  if (scope !== "roster" && scope !== "global" && scope !== "project") {
    throw new Error("scope must be roster, global, or project");
  }
  return scope;
}

/** A built-in has no file to save or delete, but its switch is persisted all the same. */
function validateToggleScope(scope: unknown): SubagentWritableScope | "builtin" {
  if (scope === "builtin") return scope;
  if (scope !== "roster" && scope !== "global" && scope !== "project") {
    throw new Error("scope must be roster, global, project, or builtin");
  }
  return scope;
}

function validateAllowedChildren(cwd: string, profile: SubagentProfileInput): void {
  const names = profile.orchestration?.allowedChildren;
  if (!Array.isArray(names)) return; // saveSubagentProfile validates malformed input.
  const effective = new Set(listSubagentProfiles(cwd)
    .filter((candidate) => candidate.enabled && !candidate.configurationError)
    .map((candidate) => candidate.name.toLowerCase()));
  for (const name of names) {
    if (typeof name !== "string") continue; // saveSubagentProfile validates malformed input.
    if (!effective.has(name.toLowerCase())) {
      throw new Error(`Allowed child agent is missing or disabled: ${name}`);
    }
  }
}

export async function GET(req: Request) {
  try {
    const cwd = await validateCwd(new URL(req.url).searchParams.get("cwd"));
    const rosterRoot = getRepositoryRosterRoot();
    return NextResponse.json({ profiles: listSubagentProfileSources(cwd), rosterAvailable: Boolean(rosterRoot),
      ...(rosterRoot ? { rosterRoot } : {}) });
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
      profile?: SubagentProfileInput;
    };
    const cwd = await validateCwd(body.cwd);
    const scope = validateScope(body.scope);
    if (!body.profile || typeof body.profile.name !== "string") {
      return NextResponse.json({ error: "profile required" }, { status: 400 });
    }
    validateAllowedChildren(cwd, body.profile);
    await validateSelectedAgentResources(cwd, body.profile);
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
    const body = await req.json() as { cwd?: unknown; scope?: unknown; name?: unknown; enabled?: unknown };
    const cwd = await validateCwd(body.cwd);
    const scope = validateToggleScope(body.scope);
    if (typeof body.name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });
    if (typeof body.enabled !== "boolean") return NextResponse.json({ error: "enabled required" }, { status: 400 });
    const name = body.name;
    const source = listSubagentProfileSources(cwd).find((profile) =>
      profile.scope === scope && profile.name.toLowerCase() === name.toLowerCase()
    );
    if (!source) return NextResponse.json({ error: "Agent profile not found" }, { status: 404 });
    if (scope === "builtin") {
      writeDisabledBuiltInSubagent(source.name, !body.enabled,
        getRepositorySubagentSettingsPath() ?? getSubagentSettingsPath());
      const effectiveEnabled = !disabledBuiltInSubagents().has(source.name.toLowerCase());
      return NextResponse.json({
        profile: { ...source, enabled: effectiveEnabled },
        source: readSubagentSettingsSources().disabledBuiltIns,
      });
    }
    const profile: SubagentProfileInput = { ...source, enabled: body.enabled };
    await validateSelectedAgentResources(cwd, profile);
    return NextResponse.json({ profile: saveSubagentProfile(cwd, scope, profile) });
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
