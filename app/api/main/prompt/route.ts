import { existsSync, statSync } from "node:fs";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";
import {
  MainPromptAccessError,
  MainPromptConflictError,
  MainPromptValidationError,
  readMainPrompt,
  saveMainPrompt,
  type MainPromptScope,
} from "@/lib/main-prompt";

export const dynamic = "force-dynamic";
const NO_STORE = { "Cache-Control": "no-store" };

async function validateCwd(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new MainPromptValidationError("Valid cwd required");
  }
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
    throw new MainPromptAccessError("Access denied");
  }
  return cwd;
}

function errorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const status = error instanceof MainPromptAccessError ? 403
    : error instanceof MainPromptConflictError ? 409
      : error instanceof MainPromptValidationError ? 400 : 500;
  return NextResponse.json(
    { error: message, ...(status === 409 ? { code: "conflict" } : {}) },
    { status, headers: NO_STORE },
  );
}

export async function GET(request: Request) {
  try {
    const cwd = await validateCwd(new URL(request.url).searchParams.get("cwd"));
    return NextResponse.json(readMainPrompt(cwd), { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403, headers: NO_STORE });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415, headers: NO_STORE });
  }
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new MainPromptValidationError("Prompt update required");
    }
    const input = body as Record<string, unknown>;
    const cwd = await validateCwd(input.cwd);
    if (input.scope !== "global" && input.scope !== "project" && input.scope !== "roster") {
      throw new MainPromptValidationError("scope must be roster, global, or project");
    }
    if (typeof input.content !== "string" || typeof input.revision !== "string") {
      throw new MainPromptValidationError("content and revision required");
    }
    const result = await saveMainPrompt(cwd, input.scope as MainPromptScope, input.content, input.revision);
    return NextResponse.json(result, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
