import { lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
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
        // The SDK follows directory links without a visited set. A pair of
        // in-root links can make skill discovery recurse exponentially, even
        // though the physical targets stay within the trusted roster.
        if (statSync(physical).isDirectory()) {
          throw new Error(`Repository skill directory symlinks are not supported: ${path}`);
        }
      } else if (entry.isDirectory()) {
        remaining.push(path);
      }
    }
  }
}

/**
 * Next fixes PI_WEB_PACKAGE_ROOT when loading its own config. Never infer it
 * from process.cwd(): an extension can change that to an untrusted task cwd.
 * Published upstream packages without a roster keep their previous behavior.
 */
function findBundledRoster(): string | undefined {
  const packageRoot = process.env.PI_WEB_PACKAGE_ROOT;
  if (!packageRoot) return undefined;
  const appRoot = realpathSync(packageRoot);
  let pkg: { name?: string };
  try {
    pkg = JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")) as { name?: string };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (pkg.name !== "@agegr/pi-web") return undefined;

  const candidate = join(appRoot, "orchestration");
  let entry: ReturnType<typeof lstatSync>;
  try {
    entry = lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("Bundled repository roster orchestration must be a directory, not a symlink");
  }
  return candidate;
}

/** Physical `<repo>/orchestration` path or undefined when the shared roster is unavailable. */
export function getRepositoryRosterRoot(): string | undefined {
  const configured = process.env.PI_WEB_ROSTER_ROOT;
  if (configured !== undefined && (!configured || configured.trim() !== configured || !isAbsolute(configured))) {
    throw new Error("PI_WEB_ROSTER_ROOT must be an absolute orchestration directory");
  }
  const candidate = configured ?? findBundledRoster();
  if (!candidate) return undefined;
  const root = realpathSync(candidate);
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
