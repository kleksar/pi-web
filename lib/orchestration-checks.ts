import { spawn } from "node:child_process";
import { createWriteStream, statSync } from "node:fs";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finished } from "node:stream/promises";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_PREVIEW_BYTES = 4_096;

export type CheckStatus = "not_run" | "passed" | "failed" | "environment_blocked";

export interface ExactCheckRequest {
  cwd: string;
  /** Exact argv, without shell expansion. First element is the executable. */
  argv: readonly string[];
  /** Explicit overrides. Values are never recorded in CheckResult. */
  env?: Readonly<Record<string, string>>;
  timeoutMs?: number;
  /** An explicit reason for a check deliberately not started. */
  notRunReason?: string;
  snapshotId?: string;
  /** Private task artifact directory; omitted checks use transient os.tmpdir(). */
  logRoot?: string;
}

export interface CheckResult {
  status: CheckStatus;
  cwd: string;
  argv: string[];
  snapshotId?: string;
  /** Only override names appear; never persist environment values or process.env. */
  envProfile: { inherited: true; overrideNames: string[] };
  startedAt: string | null;
  completedAt: string;
  durationMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  reason?: string;
  /** Complete output is stored outside the model context. */
  stdoutPath: string | null;
  stderrPath: string | null;
  stdoutPreview: string;
  stderrPreview: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

function validate(request: ExactCheckRequest): void {
  if (request.argv.length === 0 || request.argv.some((item) => !item || item.includes("\0"))) {
    throw new Error("Check argv must contain an executable and nonempty arguments without NUL bytes");
  }
  if (request.timeoutMs !== undefined && (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0)) {
    throw new Error("Check timeoutMs must be a positive integer");
  }
  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (!key || key.includes("=") || key.includes("\0") || value.includes("\0")) {
      throw new Error("Check env overrides contain an invalid name or NUL byte");
    }
  }
}

/** Executes a caller-authorized command; argv avoids shell interpolation but is not an OS sandbox. */
export async function runExactCheck(request: ExactCheckRequest): Promise<CheckResult> {
  validate(request);
  const completedAt = () => new Date().toISOString();
  const common = {
    argv: [...request.argv],
    ...(request.snapshotId ? { snapshotId: request.snapshotId } : {}),
    envProfile: { inherited: true as const, overrideNames: Object.keys(request.env ?? {}).sort() },
  };
  let cwd: string;
  try {
    cwd = await realpath(request.cwd);
    if (!statSync(cwd).isDirectory()) throw new Error(`Check cwd is not a directory: ${request.cwd}`);
  } catch (error) {
    return {
      ...common,
      cwd: request.cwd,
      status: "environment_blocked",
      startedAt: null,
      completedAt: completedAt(),
      durationMs: 0,
      exitCode: null,
      signal: null,
      reason: `Cannot access check cwd: ${error instanceof Error ? error.message : String(error)}`,
      stdoutPath: null,
      stderrPath: null,
      stdoutPreview: "",
      stderrPreview: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
  const initial = { ...common, cwd };
  if (request.notRunReason !== undefined) {
    if (!request.notRunReason.trim()) throw new Error("notRunReason must explain why the check did not run");
    return {
      ...initial,
      status: "not_run",
      startedAt: null,
      completedAt: completedAt(),
      durationMs: 0,
      exitCode: null,
      signal: null,
      reason: request.notRunReason,
      stdoutPath: null,
      stderrPath: null,
      stdoutPreview: "",
      stderrPreview: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }

  let logRoot: string;
  try {
    logRoot = request.logRoot ? await realpath(request.logRoot) : tmpdir();
    if (!statSync(logRoot).isDirectory()) throw new Error(`Check log root is not a directory: ${logRoot}`);
  } catch (error) {
    return {
      ...initial,
      status: "environment_blocked",
      startedAt: null,
      completedAt: completedAt(),
      durationMs: 0,
      exitCode: null,
      signal: null,
      reason: `Cannot access check log root: ${error instanceof Error ? error.message : String(error)}`,
      stdoutPath: null,
      stderrPath: null,
      stdoutPreview: "",
      stderrPreview: "",
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
    };
  }
  const artifactDir = await mkdtemp(join(logRoot, "pi-web-check-"));
  const stdoutPath = join(artifactDir, "stdout.log");
  const stderrPath = join(artifactDir, "stderr.log");
  const stdout = createWriteStream(stdoutPath, { flags: "wx", mode: 0o600 });
  const stderr = createWriteStream(stderrPath, { flags: "wx", mode: 0o600 });
  const stdoutFinished = finished(stdout);
  const stderrFinished = finished(stderr);
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutPreviewBytes = 0;
  let stderrPreviewBytes = 0;
  let spawnError: NodeJS.ErrnoException | undefined;
  let logError: NodeJS.ErrnoException | undefined;
  let timedOut = false;

  const child = spawn(request.argv[0], request.argv.slice(1), {
    cwd,
    env: { ...process.env, ...request.env },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  stdout.on("error", (error: NodeJS.ErrnoException) => { logError = error; child.kill(); });
  stderr.on("error", (error: NodeJS.ErrnoException) => { logError = error; child.kill(); });
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    stdout.write(chunk);
    if (stdoutPreviewBytes < MAX_PREVIEW_BYTES) {
      const piece = chunk.subarray(0, MAX_PREVIEW_BYTES - stdoutPreviewBytes);
      stdoutChunks.push(piece);
      stdoutPreviewBytes += piece.length;
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBytes += chunk.length;
    stderr.write(chunk);
    if (stderrPreviewBytes < MAX_PREVIEW_BYTES) {
      const piece = chunk.subarray(0, MAX_PREVIEW_BYTES - stderrPreviewBytes);
      stderrChunks.push(piece);
      stderrPreviewBytes += piece.length;
    }
  });
  child.once("error", (error: NodeJS.ErrnoException) => { spawnError = error; });
  let hardTimeout: ReturnType<typeof setTimeout> | undefined;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    hardTimeout = setTimeout(() => { child.kill("SIGKILL"); }, 5_000);
    hardTimeout.unref();
  }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timeout.unref();
  let exitCode: number | null = null;
  let signal: NodeJS.Signals | null = null;
  try {
    await new Promise<void>((resolvePromise) => {
      child.once("close", (code, receivedSignal) => {
        exitCode = code;
        signal = receivedSignal;
        resolvePromise();
      });
    });
  } finally {
    clearTimeout(timeout);
    if (hardTimeout) clearTimeout(hardTimeout);
    stdout.end();
    stderr.end();
    try { await Promise.all([stdoutFinished, stderrFinished]); }
    catch (error) { logError ??= error as NodeJS.ErrnoException; }
  }
  const blocked = Boolean(
    (spawnError && ["ENOENT", "EACCES", "ENOTDIR"].includes(spawnError.code ?? ""))
    || (logError && ["ENOSPC", "EACCES", "EROFS"].includes(logError.code ?? "")),
  );
  return {
    ...initial,
    status: blocked ? "environment_blocked" : !spawnError && !logError && !timedOut && exitCode === 0 ? "passed" : "failed",
    startedAt,
    completedAt: completedAt(),
    durationMs: Math.max(0, Date.now() - startedMs),
    exitCode: spawnError ? null : exitCode,
    signal: spawnError ? null : signal,
    ...(logError ? { reason: `Check output could not be preserved: ${logError.message}` }
      : spawnError ? { reason: `${spawnError.code ?? "spawn error"}: ${spawnError.message}` }
      : timedOut ? { reason: `Timed out after ${request.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms` } : {}),
    stdoutPath,
    stderrPath,
    stdoutPreview: Buffer.concat(stdoutChunks).toString("utf8"),
    stderrPreview: Buffer.concat(stderrChunks).toString("utf8"),
    stdoutBytes,
    stderrBytes,
    stdoutTruncated: stdoutBytes > MAX_PREVIEW_BYTES,
    stderrTruncated: stderrBytes > MAX_PREVIEW_BYTES,
  };
}
