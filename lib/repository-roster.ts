import { lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/** A trusted, operator-configured shared roster; never accept its path from a project or an API request. */
function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function requireRosterDirectory(root: string, name: "agents" | "skills"): string {
  const path = join(root, name);
  if (lstatSync(path).isSymbolicLink()) {
    throw new Error(`Repository roster ${name} directory cannot be a symlink`);
  }
  const physical = realpathSync(path);
  if (!within(root, physical) || !statSync(physical).isDirectory()) {
    throw new Error(`Repository roster ${name} directory must stay inside its root`);
  }
  return physical;
}

/** Fail closed before handing an external skill tree to the SDK's symlink-following scanner. */
function assertSkillTreeContained(root: string, skillsDir: string): void {
  const remaining = [skillsDir];
  const visited = new Set<string>();
  while (remaining.length) {
    const dir = remaining.pop()!;
    const physicalDir = realpathSync(dir);
    if (!within(root, physicalDir)) throw new Error(`Repository skill directory escapes its root: ${dir}`);
    if (visited.has(physicalDir)) continue;
    visited.add(physicalDir);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      // The SDK does not traverse hidden folders or dependency trees.
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const physical = realpathSync(path);
        if (!within(root, physical)) throw new Error(`Repository skill symlink escapes its root: ${path}`);
        if (statSync(physical).isDirectory()) remaining.push(path);
      } else if (entry.isDirectory()) {
        remaining.push(path);
      }
    }
  }
}

/** Physical `<repo>/orchestration` path or undefined when the shared roster is disabled. */
export function getRepositoryRosterRoot(): string | undefined {
  const configured = process.env.PI_WEB_ROSTER_ROOT;
  if (configured === undefined) return undefined;
  if (!configured || configured.trim() !== configured || !isAbsolute(configured)) {
    throw new Error("PI_WEB_ROSTER_ROOT must be an absolute orchestration directory");
  }
  const root = realpathSync(configured);
  if (!statSync(root).isDirectory()) throw new Error("PI_WEB_ROSTER_ROOT must be a directory");
  requireRosterDirectory(root, "agents");
  requireRosterDirectory(root, "skills");
  return root;
}

/** SDK additionalSkillPaths. Never pass this to a session whose skills are disabled. */
export function getRepositorySkillPaths(): string[] {
  const root = getRepositoryRosterRoot();
  if (!root) return [];
  const skillsDir = requireRosterDirectory(root, "skills");
  assertSkillTreeContained(root, skillsDir);
  return [skillsDir];
}

/** Treat both a source path and any link to it as read-only in the Skills settings panel. */
export function isRepositoryRosterSkillPath(filePath: string): boolean {
  const root = getRepositoryRosterRoot();
  if (!root || !isAbsolute(filePath)) return false;
  const skillDir = requireRosterDirectory(root, "skills");
  if (within(skillDir, resolve(filePath))) return true;
  try {
    return within(skillDir, realpathSync(filePath));
  } catch {
    return false;
  }
}
