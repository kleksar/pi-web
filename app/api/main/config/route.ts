import { NextResponse } from "next/server";
import {
  MainDispatcherConfigConflictError,
  readMainDispatcherConfig,
  saveMainDispatcherConfig,
} from "@/lib/main-dispatcher-config";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    return NextResponse.json(readMainDispatcherConfig());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const body = await req.json() as { config?: unknown; expectedRevision?: unknown };
    if (typeof body.expectedRevision !== "string") {
      return NextResponse.json({ error: "expectedRevision is required" }, { status: 400 });
    }
    return NextResponse.json(saveMainDispatcherConfig(body.config, body.expectedRevision));
  } catch (error) {
    if (error instanceof MainDispatcherConfigConflictError) {
      return NextResponse.json({ error: error.message, code: "conflict" }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
