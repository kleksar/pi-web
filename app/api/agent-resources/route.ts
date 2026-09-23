import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { loadAgentResourceCatalog } from "@/lib/agent-resource-service";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const cwd = new URL(req.url).searchParams.get("cwd");
  if (!cwd || !existsSync(cwd)) return NextResponse.json({ error: "Valid cwd required" }, { status: 400 });
  try {
    if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    return NextResponse.json(await loadAgentResourceCatalog(cwd));
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
