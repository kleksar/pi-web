import { existsSync, statSync } from "node:fs";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { validateSelectedAgentResources } from "@/lib/agent-resource-selection";
import {
  getMainAgentConfigRevision,
  MainAgentConfigConflictError,
  readMainAgentConfig,
  saveMainAgentConfig,
  validateMainAgentConfig,
} from "@/lib/main-agent-config";
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
    await validateCwd(new URL(req.url).searchParams.get("cwd"));
    return NextResponse.json({ config: readMainAgentConfig(), revision: getMainAgentConfigRevision() });
  } catch (cause) {
    return errorResponse(cause);
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });

  try {
    const body = await req.json() as { cwd?: unknown; config?: unknown; expectedRevision?: unknown };
    const cwd = await validateCwd(body.cwd);
    if (typeof body.expectedRevision !== "string") {
      return NextResponse.json({ error: "expectedRevision is required" }, { status: 400 });
    }
    const config = validateMainAgentConfig(body.config);
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
