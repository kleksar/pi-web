#!/usr/bin/env node
/** Read-only inventory of the local resources the operator proposes to remove. */
import { createHash } from "node:crypto";
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readlinkSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const roster = join(checkout, "orchestration");
const sources = [
  { local: ".agents/skills", repository: "skills", type: "directory" },
  { local: ".pi/agent/agents", repository: "agents", type: "directory" },
  { local: ".pi/agent/APPEND_SYSTEM.md", repository: "APPEND_SYSTEM.md", type: "file" },
];

function inside(root, path) {
  const part = relative(root, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
}

function git(args, timeout = 10000) {
  const result = spawnSync("git", args, {
    cwd: checkout,
    encoding: "utf8",
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function digest(path) {
  const hash = createHash("sha256");
  const handle = openSync(path, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytes;
    while ((bytes = readSync(handle, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(handle);
  }
  return hash.digest("hex");
}

/** Content-address an intentionally retired file or whole skill tree, including link identity. */
export function fingerprintRetiredResource(path) {
  const ancestors = new Set();
  let entries = 0;
  function visit(entry) {
    if (++entries > 100_000) throw new Error("Resource contains over 100,000 entries");
    const link = lstatSync(entry).isSymbolicLink();
    const physical = realpathSync(entry);
    const kind = statSync(entry);
    const hash = createHash("sha256");
    if (link) hash.update(`link\0${readlinkSync(entry)}\0`);
    else hash.update("direct\0");
    if (kind.isDirectory()) {
      if (ancestors.has(physical)) throw new Error("Symbolic link cycle");
      ancestors.add(physical);
      hash.update("directory\0");
      for (const name of readdirSync(entry).sort()) {
        hash.update(name).update("\0").update(visit(join(entry, name))).update("\0");
      }
      ancestors.delete(physical);
    } else if (kind.isFile()) hash.update("file\0").update(digest(entry));
    else throw new Error("Unsupported file type");
    return hash.digest("hex");
  }
  return visit(path);
}

function canRetire(label) {
  return /^\.agents\/skills\/[^/]+(?:\/.*)?$/.test(label) ||
    /^\.pi\/agent\/agents\/(?!settings\.json$)[^/]+$/.test(label);
}

/** Compare exact bytes, including skill supporting files. No local content is printed or uploaded. */
export function inspectLocalResources(home, rosterRoot, tracked, reviewed = new Map(), retired = new Map()) {
  const blockers = [];
  const observations = [];
  const usedReviewed = new Set();
  const usedRetired = new Set();
  let checked = 0;
  let entries = 0;
  const rosterPhysical = realpathSync(rosterRoot);
  const fail = (message) => blockers.push(message);
  const rosterRelative = (path) => `orchestration/${relative(rosterRoot, path).split(sep).join("/")}`;
  function retirementHint(label, local) {
    if (!canRetire(label)) return "";
    try { return `; if intentionally retiring, inspect privately and use --retired ${label}=${fingerprintRetiredResource(local)}`; }
    catch { return "; inspect this resource privately before retiring it"; }
  }

  function compare(local, target) {
    const label = relative(home, local);
    if (++entries > 100_000) {
      if (entries === 100_001) fail("Local roster contains over 100,000 entries; inspect it in smaller groups.");
      return;
    }
    let physical;
    try { physical = realpathSync(local); }
    catch { fail(`${label}: dangling link or unreadable resource`); return; }
    if (retired.has(label)) {
      usedRetired.add(label);
      if (!canRetire(label)) { fail(`${label}: Main prompt and sub-agent settings cannot be retired`); return; }
      try {
        if (fingerprintRetiredResource(local) === retired.get(label)) {
          observations.push(`${label}: explicitly reviewed retirement; no Git replacement expected`);
        } else fail(`${label}: changed since --retired acknowledgment; inspect again${retirementHint(label, local)}`);
      } catch {
        fail(`${label}: cannot fingerprint retired resource; inspect manually`);
      }
      return;
    }
    if (lstatSync(local).isSymbolicLink()) observations.push(`${label}: symbolic link; review users of its external source`);
    const kind = statSync(local);
    if (kind.isDirectory()) {
      if (basename(local) === ".git" || basename(local) === "node_modules") {
        fail(`${label}: separate Git metadata or dependencies must be reviewed before removal${retirementHint(label, local)}`);
        return;
      }
      if (!existsSync(target) || !statSync(target).isDirectory()) {
        fail(`${label}: no corresponding repository directory ${rosterRelative(target)}${retirementHint(label, local)}`);
        return;
      }
      // Cycles can occur in manually linked skill trees; don't follow them forever.
      if (ancestors.has(physical)) { fail(`${label}: symbolic link cycle`); return; }
      ancestors.add(physical);
      const names = readdirSync(local).sort();
      for (const name of names) compare(join(local, name), join(target, name));
      ancestors.delete(physical);
      return;
    }
    if (!kind.isFile()) { fail(`${label}: unsupported file type${retirementHint(label, local)}`); return; }
    const targetLabel = rosterRelative(target);
    if (!existsSync(target)) { fail(`${label}: missing in Git catalog (${targetLabel})${retirementHint(label, local)}`); return; }
    let targetPhysical;
    try { targetPhysical = realpathSync(target); }
    catch { fail(`${targetLabel}: unreadable repository resource`); return; }
    if (!inside(rosterPhysical, targetPhysical)) {
      fail(`${targetLabel}: repository link escapes orchestration/`);
      return;
    }
    if (!statSync(target).isFile() || !tracked.has(targetLabel)) {
      fail(`${targetLabel}: no tracked regular file in Git`);
      return;
    }
    checked++;
    const localDigest = digest(local);
    const targetDigest = digest(target);
    if (localDigest !== targetDigest) {
      const signature = `${localDigest}:${targetDigest}`;
      if (reviewed.get(label) === signature) {
        usedReviewed.add(label);
        observations.push(`${label}: reviewed replacement of differing local bytes by ${targetLabel}`);
      } else {
        fail(`${label}: differs from ${targetLabel}; inspect privately and, if intentional, acknowledge with --reviewed ${label}=${signature}`);
      }
    }
  }

  const ancestors = new Set();
  for (const source of sources) {
    const local = join(home, source.local);
    const target = join(rosterRoot, source.repository);
    if (!existsSync(local) && !isDanglingLink(local)) {
      observations.push(`${source.local}: absent`);
      continue;
    }
    if (source.type === "directory") {
      if (!existsSync(local) || !statSync(local).isDirectory()) {
        fail(`${source.local}: expected directory; inspect it manually`);
        continue;
      }
      if (lstatSync(local).isSymbolicLink()) {
        observations.push(`${source.local}: root directory is a symbolic link; review its original users`);
      }
      for (const name of readdirSync(local).sort()) {
        const destination = source.local === ".pi/agent/agents" && name === "settings.json"
          ? join(rosterRoot, "subagent-settings.json") : join(target, name);
        compare(join(local, name), destination);
      }
    } else {
      compare(local, target);
    }
  }
  const otherSkills = join(home, ".pi/agent/skills");
  if (existsSync(otherSkills) && statSync(otherSkills).isDirectory() && readdirSync(otherSkills).length) {
    fail(".pi/agent/skills/: additional global resources outside the proposed migration remain; inspect their owners and usage");
  }
  const globalMain = join(home, ".pi/agent/main-agent-config.json");
  if (existsSync(globalMain)) {
    try {
      const settings = JSON.parse(readFileSync(globalMain, "utf8"));
      if (!settings || typeof settings !== "object" || Array.isArray(settings) ||
          Object.keys(settings).some((key) => key !== "version")) {
        fail(".pi/agent/main-agent-config.json: local Main overrides may shadow the repository default; inspect or migrate separately");
      }
    } catch {
      fail(".pi/agent/main-agent-config.json: unreadable local Main settings; inspect separately");
    }
  }
  for (const label of reviewed.keys()) {
    if (!usedReviewed.has(label)) fail(`${label}: unused or stale --reviewed acknowledgment`);
  }
  for (const label of retired.keys()) {
    if (!usedRetired.has(label)) fail(`${label}: unused or stale --retired acknowledgment`);
  }
  return { blockers, observations, checked };
}

function isDanglingLink(path) {
  try { return lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function gitChecks() {
  const blockers = [];
  const trackedOutput = git(["ls-files", "-z", "--", "orchestration", "scripts/check-roster-migration.mjs", "docs/roster-migration.md"]);
  if (trackedOutput === null) return { tracked: new Set(), blockers: ["Cannot inspect Git index for orchestration/."] };
  const tracked = new Set(trackedOutput.split("\0").filter(Boolean));
  for (const required of [
    "orchestration/APPEND_SYSTEM.md", "orchestration/subagent-settings.json", "orchestration/main-agent-config.json",
    "scripts/check-roster-migration.mjs", "docs/roster-migration.md",
  ]) {
    if (!tracked.has(required)) blockers.push(`${required}: missing from Git index`);
  }
  if (!tracked.size) blockers.push("No repository roster files are tracked in Git.");
  const dirty = git(["status", "--porcelain", "--untracked-files=all", "--", "orchestration", "scripts/check-roster-migration.mjs", "docs/roster-migration.md"]);
  if (dirty === null || dirty) blockers.push("Roster, preflight script, or migration guide contains changes outside the current commit.");
  const remote = git(["ls-remote", "origin", "refs/heads/develop"], 20000);
  const remoteHash = remote?.split(/\s+/)[0];
  if (!remoteHash || !/^[0-9a-f]{40,64}$/.test(remoteHash)) {
    blockers.push("Cannot verify published origin/develop; check network and Git remote.");
  } else {
    const localHash = git(["rev-parse", "refs/remotes/origin/develop"]);
    if (localHash !== remoteHash) {
      blockers.push("Local origin/develop is stale; run git fetch origin develop and rerun.");
    } else if (git(["merge-base", "--is-ancestor", "HEAD", "refs/remotes/origin/develop"]) === null) {
      blockers.push("This committed roster is not yet on origin/develop; merge reviewed PRs and rerun.");
    }
  }
  return { tracked, blockers };
}

function main() {
  const args = process.argv.slice(2);
  const home = homedir();
  let json = false;
  const reviewed = new Map();
  const retired = new Map();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--json") json = true;
    else if (args[i] === "--reviewed" && args[i + 1]) {
      const item = args[++i];
      const match = /^(.+)=([a-f0-9]{64}:[a-f0-9]{64})$/.exec(item);
      if (!match) { process.stderr.write("--reviewed requires relative/path=localSHA256:repositorySHA256\n"); process.exitCode = 2; return; }
      reviewed.set(match[1], match[2]);
    }
    else if (args[i] === "--retired" && args[i + 1]) {
      const item = args[++i];
      const match = /^(.+)=([a-f0-9]{64})$/.exec(item);
      if (!match) { process.stderr.write("--retired requires relative/path=resourceSHA256\n"); process.exitCode = 2; return; }
      retired.set(match[1], match[2]);
    }
    else {
      process.stderr.write("Usage: node scripts/check-roster-migration.mjs [--json] [--reviewed local/path=localSHA256:repositorySHA256] [--retired local/path=resourceSHA256]\n");
      process.exitCode = 2;
      return;
    }
  }
  const blockers = [];
  const expected = realpathSync(roster);
  if (!isAbsolute(process.env.PI_WEB_ROSTER_ROOT ?? "") ||
      !existsSync(process.env.PI_WEB_ROSTER_ROOT ?? "") ||
      realpathSync(process.env.PI_WEB_ROSTER_ROOT) !== expected) {
    blockers.push(`PI_WEB_ROSTER_ROOT must name this checkout's absolute orchestration path: ${expected}`);
  }
  const gitState = gitChecks();
  blockers.push(...gitState.blockers);
  const inventory = inspectLocalResources(home, roster, gitState.tracked, reviewed, retired);
  blockers.push(...inventory.blockers);
  const result = { status: blockers.length ? "BLOCKED" : "INVENTORY MATCHED; RUNTIME TEST STILL REQUIRED", checkedFiles: inventory.checked, blockers, observations: inventory.observations };
  if (json) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  else {
    process.stdout.write(`${result.status}\nCompared ${result.checkedFiles} local file(s).\n`);
    for (const item of blockers) process.stdout.write(`BLOCKER: ${item}\n`);
    for (const item of result.observations) process.stdout.write(`INFO: ${item}\n`);
    process.stdout.write("This only compares inventory and Git state; it never deletes files. Run the clean-home smoke test before removal.\n");
  }
  process.exitCode = blockers.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
