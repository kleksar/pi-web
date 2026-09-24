import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** The shared roster is writable only inside a Git checkout of this application. */
export function getRepositoryRosterRoot(): string | undefined {
  const configured = process.env.PI_WEB_ROSTER_ROOT;
  if (configured !== undefined && (!configured || configured.trim() !== configured || !isAbsolute(configured))) {
    throw new Error("PI_WEB_ROSTER_ROOT must be an absolute orchestration directory");
  }

  const packageRoot = process.env.PI_WEB_PACKAGE_ROOT;
  if (!configured && !packageRoot) return undefined;
  if (!configured && packageRoot) {
    const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as { name?: string };
    if (pkg.name !== "@agegr/pi-web") return undefined;
  }

  const candidate = configured ?? join(packageRoot!, "orchestration");
  if (!existsSync(candidate)) return undefined;
  if (lstatSync(candidate).isSymbolicLink() || !lstatSync(candidate).isDirectory()) {
    throw new Error("Repository roster must be a regular directory");
  }
  const root = realpathSync(candidate);
  const checkout = dirname(root);
  // A package installation has no Git metadata; never label an untracked local
  // directory "Repository" in the UI or promise its changes can be committed.
  if (!existsSync(join(checkout, ".git"))) return undefined;

  const agents = join(root, "agents");
  if (lstatSync(agents).isSymbolicLink() || !lstatSync(agents).isDirectory()) {
    throw new Error("Repository roster agents must be a regular directory");
  }
  const physical = realpathSync(agents);
  const path = relative(root, physical);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) {
    throw new Error("Repository roster agents must remain inside the checkout");
  }
  return root;
}
