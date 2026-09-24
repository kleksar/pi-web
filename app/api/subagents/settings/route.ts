import { NextResponse } from "next/server";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  readSubagentSettings,
  readSubagentSettingsSources,
  getRepositorySubagentSettingsPath,
  getSubagentSettingsPath,
  MAX_SUBAGENT_MAX_CONCURRENT,
  writeBuiltInSubagentsEnabled,
  writeSubagentMaxConcurrent,
} from "@/lib/subagent-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const settings = readSubagentSettings();
    const repoPath = getRepositorySubagentSettingsPath();
    return NextResponse.json({
      enabled: settings.builtInEnabled,
      maxConcurrent: settings.maxConcurrent,
      sources: readSubagentSettingsSources(),
      defaultEditScope: repoPath ? "roster" : "local",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(req)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  try {
    const body = await req.json() as { enabled?: unknown; maxConcurrent?: unknown; scope?: unknown };
    if (body.enabled === undefined && body.maxConcurrent === undefined) {
      return NextResponse.json({ error: "enabled or maxConcurrent is required" }, { status: 400 });
    }
    if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
    }
    if (body.maxConcurrent !== undefined && (
      typeof body.maxConcurrent !== "number"
      || !Number.isInteger(body.maxConcurrent)
      || body.maxConcurrent < 1
      || body.maxConcurrent > MAX_SUBAGENT_MAX_CONCURRENT
    )) {
      return NextResponse.json({ error: `maxConcurrent must be an integer between 1 and ${MAX_SUBAGENT_MAX_CONCURRENT}` }, { status: 400 });
    }
    if (body.scope !== undefined && body.scope !== "roster" && body.scope !== "local") {
      return NextResponse.json({ error: "scope must be roster or local" }, { status: 400 });
    }
    const repoPath = getRepositorySubagentSettingsPath();
    const scope = body.scope ?? (repoPath ? "roster" : "local");
    if (scope === "roster" && !repoPath) {
      return NextResponse.json({ error: "Repository roster is unavailable" }, { status: 400 });
    }
    const settingsPath = scope === "roster" ? repoPath! : getSubagentSettingsPath();
    if (body.enabled !== undefined) writeBuiltInSubagentsEnabled(body.enabled, settingsPath);
    if (body.maxConcurrent !== undefined) writeSubagentMaxConcurrent(body.maxConcurrent, settingsPath);
    const settings = readSubagentSettings();
    return NextResponse.json({
      enabled: settings.builtInEnabled,
      maxConcurrent: settings.maxConcurrent,
      sources: readSubagentSettingsSources(),
      defaultEditScope: repoPath ? "roster" : "local",
      savedScope: scope,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
