import { NextResponse } from "next/server";
import { existsSync } from "fs";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import {
  deleteSubagentProfile,
  listSubagentProfileSources,
  saveSubagentProfile,
  type SubagentProfile,
  type SubagentWritableScope,
} from "@/lib/subagents";
import { writeDisabledBuiltInSubagent } from "@/lib/subagent-settings";

export const dynamic = "force-dynamic";

async function validateCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd || !existsSync(cwd)) throw new Error("Valid cwd required");
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new Error("Access denied");
  return cwd;
}

function validateScope(scope: unknown): SubagentWritableScope {
  if (scope !== "global" && scope !== "project") throw new Error("scope must be global or project");
  return scope;
}

/** A built-in has no file to save or delete, but its switch is persisted all the same. */
function validateToggleScope(scope: unknown): SubagentWritableScope | "builtin" {
  if (scope === "builtin") return scope;
  if (scope !== "global" && scope !== "project") throw new Error("scope must be global, project, or builtin");
  return scope;
}

export async function GET(req: Request) {
  try {
    const params = new URL(req.url).searchParams;
    const cwd = await validateCwd(params.get("cwd"));
    const orchestration = params.get("orchestration");
    if (orchestration !== null && orchestration !== "1") throw new Error("orchestration must be 1");
    const profiles = listSubagentProfileSources(cwd, { orchestrationEnabled: orchestration === "1" });
    if (orchestration !== "1") return NextResponse.json({ profiles });
    const regularBuiltins = new Set(listSubagentProfileSources(cwd)
      .filter((item) => item.scope === "builtin").map((item) => item.name));
    return NextResponse.json({ profiles,
      orchestrationProfileNames: profiles.filter((item) => item.scope === "builtin" && !regularBuiltins.has(item.name)).map((item) => item.name),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: message === "Access denied" ? 403 : 400 });
  }
}

export async function PUT(req: Request) {
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
  try {
    const body = await req.json() as { cwd?: unknown; scope?: unknown; name?: unknown; enabled?: unknown; orchestration?: unknown };
    if (body.orchestration !== undefined && typeof body.orchestration !== "boolean") throw new Error("orchestration must be a boolean");
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
      writeDisabledBuiltInSubagent(source.name, !body.enabled);
      return NextResponse.json({ profile: { ...source, enabled: body.enabled } });
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
