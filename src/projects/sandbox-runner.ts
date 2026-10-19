import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getEnv } from "../config/env.js";
import type { Project, ProjectCommands } from "../domain/entities.js";
import type { GithubRepoRef, IGitHubService } from "../github/types.js";
import { LocalGitService } from "../github/local-git-service.js";
import { parseRepoFullName } from "../github/types.js";
import { isSensitivePath } from "../filesystem/filesystem-service.js";
import { normalizeProjectCommands } from "../analyzer/project-commands.js";
import {
  prepareProjectFiles,
  projectArchiveLimitsFromEnv,
  safeProjectArchivePath,
  type ProjectArchiveFile,
} from "./project-archive.js";
import { collectSafeFolderFiles } from "./local-project-service.js";
import type { ToolResult } from "../tools/types.js";

export type SandboxStage = "test" | "build" | "lint" | "install" | "start";

/**
 * What to do about the sandbox image before `docker run`:
 *   - "never"   (default) rely on `--pull=never`; a missing image fails with an
 *               explicit "run docker pull <image>" message;
 *   - "missing" inspect the image first and pull it only when it is absent;
 *   - "always"  pull before every run (refresh to the tag's current digest).
 */
export type SandboxImagePolicy = "never" | "missing" | "always";

export interface DockerExecutionResult {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
  aborted: boolean;
  outputLimited: boolean;
  durationMs: number;
}

export type DockerProcessRunner = (
  dockerBin: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  tailBytes: number,
) => Promise<DockerExecutionResult>;

export interface SandboxRunnerOptions {
  dockerBin?: string;
  image?: string;
  timeoutMs?: number;
  memoryMb?: number;
  cpus?: number;
  pidsLimit?: number;
  tailBytes?: number;
  workspaceRoot?: string;
  imagePull?: SandboxImagePolicy;
  runDocker?: DockerProcessRunner;
}

export interface SandboxVerifyInput {
  project: Project;
  github: IGitHubService;
  repoName?: string;
  ref?: string;
  expectedSha?: string;
  stage: "test" | "build";
  signal?: AbortSignal;
  checkActive?: () => void;
}

interface ExportedTree {
  sha: string;
  files: ProjectArchiveFile[];
}

const bytes = (n: number): string => `${Math.max(1, Math.floor(n))}m`;

function positiveNumber(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= max ? parsed : fallback;
}

export function sandboxConfigFromEnv(options: SandboxRunnerOptions = {}) {
  // Validated contract (src/config/env.ts): a bad value fails at boot instead of
  // silently changing how much CPU/memory a repository's own code may consume.
  const env = getEnv();
  const number = (value: number | undefined, fallback: number, max: number): number =>
    positiveNumber(value === undefined ? undefined : String(value), fallback, max);
  return {
    dockerBin: options.dockerBin ?? env.PROJECT_SANDBOX_DOCKER_BIN ?? "docker",
    image: options.image ?? env.PROJECT_SANDBOX_IMAGE,
    timeoutMs: options.timeoutMs ?? number(env.PROJECT_SANDBOX_TIMEOUT_MS, 8 * 60_000, 10 * 60_000),
    memoryMb: options.memoryMb ?? number(env.PROJECT_SANDBOX_MEMORY_MB, 1024, 16 * 1024),
    cpus: options.cpus ?? number(env.PROJECT_SANDBOX_CPUS, 1, 8),
    pidsLimit: options.pidsLimit ?? Math.floor(number(env.PROJECT_SANDBOX_PIDS_LIMIT, 128, 4096)),
    tailBytes: options.tailBytes ?? Math.floor(number(env.PROJECT_SANDBOX_LOG_TAIL_BYTES, 12_000, 256_000)),
    workspaceRoot: resolve(options.workspaceRoot ?? env.PROJECT_SANDBOX_DIR ?? tmpdir()),
    imagePull: options.imagePull ?? env.PROJECT_SANDBOX_IMAGE_PULL ?? "never",
    runDocker: options.runDocker ?? runDockerProcess,
  };
}

function stackImage(project: Project): string {
  const language = (project.analysis?.languages ?? project.capabilities?.languages ?? []).join(" ").toLowerCase();
  if (/python/.test(language)) return "python:3.12-slim";
  if (/\bgo\b|golang/.test(language)) return "golang:1.24-alpine";
  if (/rust/.test(language)) return "rust:1.88-slim";
  if (/php/.test(language)) return "php:8.3-cli-alpine";
  return "node:22-alpine";
}

function commandsFor(project: Project): ProjectCommands {
  const value = project.commands ?? project.analysis?.commands ?? project.analysis?.suggestions?.commands ?? {};
  return normalizeProjectCommands(value) ?? {};
}

function tailAppend(current: Buffer, next: Buffer, max: number): Buffer {
  const combined = Buffer.concat([current, next]);
  return combined.length > max ? combined.subarray(combined.length - max) : combined;
}

async function runDockerProcess(
  dockerBin: string,
  args: string[],
  timeoutMs: number,
  signal: AbortSignal | undefined,
  tailBytes: number,
): Promise<DockerExecutionResult> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(dockerBin, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolvePromise({
        exitCode: 127,
        stdoutTail: "",
        stderrTail: `Could not start Docker: ${String(error)}`,
        timedOut: false,
        aborted: false,
        outputLimited: false,
        durationMs: Date.now() - started,
      });
      return;
    }
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let timedOut = false;
    let aborted = false;
    let outputLimited = false;
    let totalOutputBytes = 0;
    let settled = false;
    const killGrace = 1500;
    let killTimer: NodeJS.Timeout | undefined;
    const forceStop = (kind: "timeout" | "abort" | "output") => {
      if (kind === "timeout") timedOut = true;
      if (kind === "abort") aborted = true;
      if (kind === "output") outputLimited = true;
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => child.kill("SIGKILL"), killGrace);
        killTimer.unref?.();
      }
    };
    const timer = setTimeout(() => forceStop("timeout"), timeoutMs);
    timer.unref?.();
    const onAbort = () => forceStop("abort");
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    const maxOutputBytes = tailBytes * 100;
    child.stdout?.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalOutputBytes += value.length;
      stdout = tailAppend(stdout, value, tailBytes);
      if (totalOutputBytes > maxOutputBytes && !outputLimited) forceStop("output");
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalOutputBytes += value.length;
      stderr = tailAppend(stderr, value, tailBytes);
      if (totalOutputBytes > maxOutputBytes && !outputLimited) forceStop("output");
    });
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      const code = (error as NodeJS.ErrnoException).code;
      resolvePromise({
        exitCode: code === "ENOENT" ? 127 : 1,
        stdoutTail: stdout.toString("utf8"),
        stderrTail: code === "ENOENT" ? `Docker executable not found: ${dockerBin}` : String(error),
        timedOut,
        aborted,
        outputLimited,
        durationMs: Date.now() - started,
      });
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", onAbort);
      resolvePromise({
        exitCode: typeof code === "number" ? code : 1,
        stdoutTail: stdout.toString("utf8"),
        stderrTail: stderr.toString("utf8"),
        timedOut,
        aborted,
        outputLimited,
        durationMs: Date.now() - started,
      });
    });
  });
}

async function writeWorkspace(workspace: string, files: readonly ProjectArchiveFile[]): Promise<void> {
  await fsp.mkdir(workspace, { recursive: true, mode: 0o777 });
  await fsp.chmod(workspace, 0o777);
  for (const file of files) {
    const safe = safeProjectArchivePath(file.path);
    const parts = safe.split("/");
    const destination = resolve(workspace, ...parts);
    const rel = relative(workspace, destination);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || resolve(workspace, rel) !== destination)
      throw new Error(`Unsafe sandbox source path: ${file.path}`);
    const dir = join(workspace, ...parts.slice(0, -1));
    await fsp.mkdir(dir, { recursive: true, mode: 0o777 });
    await fsp.chmod(dir, 0o777);
    await fsp.writeFile(destination, file.content, { flag: "wx", mode: 0o666 });
  }
}

/**
 * A folder project created with `gitInit: false` owns no repository: no
 * `configRepo`, no local-git working copy. Its only source of truth is
 * `project.localPath`, which the sandbox reads directly instead of pretending
 * there is a GitHub ref to resolve.
 */
export function sandboxFolderSource(project: Project): string | undefined {
  if (project.sourceType !== "local") return undefined;
  if (project.configRepo?.trim()) return undefined;
  const localPath = project.localPath?.trim();
  return localPath ? localPath : undefined;
}

/**
 * Export a server folder as a sandbox source tree. Uses the very same walk as
 * project creation (`collectSafeFolderFiles`): bounded file count/size/total,
 * no symlinks or special files, and secret-bearing paths excluded.
 */
async function exportLocalFolderTree(rootPath: string): Promise<ExportedTree> {
  const limits = projectArchiveLimitsFromEnv();
  const collected = await collectSafeFolderFiles(rootPath);
  const prepared = prepareProjectFiles(collected.files, limits);
  const hash = createHash("sha256");
  for (const file of [...prepared.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    hash.update(file.path);
    hash.update("\0");
    hash.update(file.content);
    hash.update("\0");
  }
  // No commit exists to pin: the digest identifies the exact file contents the
  // container was given, so the evidence says which tree was executed.
  return { sha: hash.digest("hex"), files: prepared.files };
}

async function exportGithubTree(
  github: IGitHubService,
  repo: GithubRepoRef,
  ref: string,
  expectedSha: string | undefined,
): Promise<ExportedTree> {
  const limits = projectArchiveLimitsFromEnv();
  const local = github instanceof LocalGitService ? github : undefined;
  if (local) {
    const tree = await local.exportTreeFiles(repo, expectedSha || ref, {
      maxFiles: limits.maxFiles,
      maxFileBytes: limits.maxFileBytes,
      maxTotalBytes: limits.maxTotalBytes,
    });
    return { sha: tree.sha, files: prepareProjectFiles(tree.files, limits).files };
  }
  const commits = await github.listCommits(repo, ref);
  const sha = expectedSha || commits[0]?.sha || (/^[a-f0-9]{40,64}$/i.test(ref) ? ref : undefined);
  if (!sha) throw new Error(`Cannot resolve an immutable commit for ${repo.owner}/${repo.name}@${ref}`);
  const entries = await github.listFiles(repo, sha);
  const treeEntries = entries.filter((entry) => entry.type === "blob");
  if (treeEntries.length > limits.maxFiles)
    throw new Error(`Repository exceeds sandbox file limit (${limits.maxFiles})`);
  const files: ProjectArchiveFile[] = [];
  let total = 0;
  for (const entry of treeEntries) {
    const path = safeProjectArchivePath(entry.path);
    if (entry.mode === "120000") throw new Error(`Sandbox refuses repository symbolic links: ${path}`);
    if (isSensitivePath(path)) continue;
    if (typeof entry.size === "number" && entry.size > limits.maxFileBytes)
      throw new Error(`Sandbox file exceeds ${limits.maxFileBytes} bytes: ${path}`);
    const file = github.getFileBuffer
      ? await github.getFileBuffer(repo, path, sha)
      : await github
          .getFile(repo, path, sha)
          .then((value) => value && { ...value, content: Buffer.from(value.content, "utf8") });
    if (!file) throw new Error(`Could not read repository file for sandbox: ${path}`);
    if (typeof entry.size === "number" && file.content.length !== entry.size)
      throw new Error(`Repository file size changed while exporting: ${path}`);
    total += file.content.length;
    if (file.content.length > limits.maxFileBytes || total > limits.maxTotalBytes)
      throw new Error(`Repository source exceeds configured sandbox file limits at ${path}`);
    files.push({ path, content: file.content });
  }
  const prepared = prepareProjectFiles(files, limits);
  return { sha, files: prepared.files };
}

function stageCommands(
  commands: ProjectCommands,
  stage: SandboxStage,
): { commands: Array<{ stage: string; command: string }>; required: boolean } {
  const selected: Array<{ stage: string; command: string }> = [];
  const add = (name: keyof ProjectCommands) => {
    const command = commands[name]?.trim();
    if (command) selected.push({ stage: name, command });
  };
  if (stage === "test") {
    add("install");
    add("test");
    add("lint");
    return { commands: selected, required: !!commands.test?.trim() };
  }
  if (stage === "build") {
    add("install");
    add("build");
    add("test");
    add("lint");
    return { commands: selected, required: !!commands.build?.trim() };
  }
  add(stage);
  return { commands: selected, required: !!commands[stage]?.trim() };
}

/**
 * Stages whose failure is attributable to the project's own code and can
 * therefore be repaired by an agent. `install` failures are environment/
 * dependency problems (with `--network=none` they are the normal outcome),
 * and `start` is a long-running command usually ended by the timeout — sending
 * either back into the QA→fix loop would burn the task budget on something a
 * code edit cannot change.
 */
const CODE_STAGES: ReadonlySet<string> = new Set(["build", "test", "lint"]);

/**
 * In-container script for the selected steps.
 *
 * Each step is announced with a marker, and an EXIT trap appends
 * `failed-stage=<stage>` **after** the failing command's output. The trap line
 * is therefore always part of the retained stdout tail, so the platform can
 * tell whether an install step or a test/build step failed even when the tail
 * is truncated.
 */
export function sandboxScript(steps: ReadonlyArray<{ stage: string; command: string }>): string {
  return [
    "set -e",
    "codevia_stage=",
    'codevia_report() { codevia_status=$?; if [ "$codevia_status" -ne 0 ] && [ -n "$codevia_stage" ]; then ' +
      'printf \'\\n[CodeVia sandbox] failed-stage=%s exit=%s\\n\' "$codevia_stage" "$codevia_status"; fi; }',
    "trap codevia_report EXIT",
    ...steps.map(
      ({ stage, command }) => `printf '\\n[CodeVia sandbox] ${stage}\\n'; codevia_stage=${stage}; ${command}`,
    ),
  ].join("\n");
}

/**
 * Container network for a sandbox execution:
 *   - "none"         every step runs with `--network=none` (default);
 *   - "install-only" `install` runs alone with `--network=bridge`, then the
 *                    remaining steps run offline on the same workspace;
 *   - "full"         one container with `--network=bridge` for every step.
 */
export type SandboxNetworkMode = "none" | "install-only" | "full";

export function sandboxNetworkMode(project: Pick<Project, "settings">): SandboxNetworkMode {
  if (project.settings?.sandboxNetworkAccess === true) return "full";
  if (project.settings?.sandboxInstallNetwork === true) return "install-only";
  return "none";
}

export interface SandboxPhase {
  steps: Array<{ stage: string; command: string }>;
  network: boolean;
}

/** Split the selected steps into the containers that will run them, in order. */
export function sandboxPhases(
  steps: ReadonlyArray<{ stage: string; command: string }>,
  mode: SandboxNetworkMode,
): SandboxPhase[] {
  if (mode === "full") return [{ steps: [...steps], network: true }];
  const install = steps.filter((step) => step.stage === "install");
  if (mode === "none" || !install.length) return [{ steps: [...steps], network: false }];
  const rest = steps.filter((step) => step.stage !== "install");
  return rest.length
    ? [
        { steps: install, network: true },
        { steps: rest, network: false },
      ]
    : [{ steps: install, network: true }];
}

/** HOME inside the container when install and the offline steps are split. */
export const SANDBOX_PERSISTENT_HOME = "/codevia-home";

/**
 * Where tools keep caches and per-user installs. A single container uses its
 * tmpfs. When install and the offline steps run in separate containers, the
 * tmpfs does not survive, so HOME and every tool cache live on a dedicated
 * scratch volume shared by both containers — `pip install` (user site), Go
 * modules, Cargo registries and Poetry virtualenvs fetched with network are
 * then available offline. The volume is outside /workspace on purpose: lint
 * and test globs never see cache files, and the repository cannot pre-seed
 * HOME (e.g. a `.profile` sourced by the login shell).
 */
function cacheEnv(persistent: boolean): string[] {
  const home = persistent ? SANDBOX_PERSISTENT_HOME : "/tmp";
  const vars: Record<string, string> = {
    HOME: home,
    TMPDIR: "/tmp",
    CI: "true",
    npm_config_cache: `${home}/npm-cache`,
    PIP_CACHE_DIR: `${home}/pip-cache`,
    GOCACHE: `${home}/go-build`,
    GOMODCACHE: `${home}/go-mod`,
    CARGO_HOME: `${home}/cargo`,
    POETRY_CACHE_DIR: `${home}/poetry-cache`,
  };
  return Object.entries(vars).flatMap(([key, value]) => ["--env", `${key}=${value}`]);
}

/** Concatenate two retained tails and keep only the last `limit` characters. */
function joinTails(first: string, second: string, limit: number): string {
  const joined = [first, second].filter(Boolean).join("\n");
  return joined.length > limit ? joined.slice(joined.length - limit) : joined;
}

/** Stage reported by the EXIT trap, or `undefined` when the failure is unknown. */
export function sandboxFailedStage(
  result: Pick<DockerExecutionResult, "stdoutTail" | "stderrTail">,
): string | undefined {
  const pattern = /\[CodeVia sandbox\] failed-stage=([a-z]+) exit=\d+/;
  return (pattern.exec(result.stdoutTail) ?? pattern.exec(result.stderrTail))?.[1];
}

/** Only a failing project-code step (test/build/lint) may enter the fix loop. */
export function isFixableSandboxFailure(
  result: Pick<DockerExecutionResult, "stdoutTail" | "stderrTail" | "timedOut" | "aborted" | "outputLimited">,
  failedStage: string | undefined = sandboxFailedStage(result),
): boolean {
  if (result.timedOut || result.aborted || result.outputLimited) return false;
  return !!failedStage && CODE_STAGES.has(failedStage);
}

/**
 * Executes project lifecycle commands only inside a disposable Docker
 * container. It deliberately has no host-shell fallback.
 */
export class SandboxRunner {
  private readonly config: ReturnType<typeof sandboxConfigFromEnv>;

  constructor(options: SandboxRunnerOptions = {}) {
    this.config = sandboxConfigFromEnv(options);
  }

  private dockerUnavailable(result: DockerExecutionResult): boolean {
    return (
      result.exitCode === 127 ||
      /Docker executable not found|Could not start Docker|Cannot connect to the Docker daemon|Is the docker daemon running/i.test(
        result.stderrTail,
      )
    );
  }

  /**
   * Explicit, configurable image step before `docker run` (which always keeps
   * `--pull=never`). Returns an actionable problem, or `undefined` to continue.
   */
  private async prepareImage(
    image: string,
    signal: AbortSignal | undefined,
  ): Promise<{ output: string; data: Record<string, unknown> } | undefined> {
    const policy = this.config.imagePull;
    if (policy === "never") return undefined;
    if (policy === "missing") {
      const inspected = await this.config.runDocker(
        this.config.dockerBin,
        ["image", "inspect", "--format", "{{.Id}}", image],
        Math.min(this.config.timeoutMs, 60_000),
        signal,
        this.config.tailBytes,
      );
      if (inspected.exitCode === 0) return undefined;
      if (this.dockerUnavailable(inspected))
        return {
          output: `Docker is unavailable, so the sandbox image "${image}" could not be checked: ${inspected.stderrTail || "docker CLI not found"}`,
          data: { sandbox: "unavailable" },
        };
    }
    // A pull streams progress lines; allow a larger output window (the retained
    // tail is still `tailBytes`) so a normal download is not killed as "output
    // limited" before the image finishes.
    const pulled = await this.config.runDocker(
      this.config.dockerBin,
      ["pull", image],
      this.config.timeoutMs,
      signal,
      Math.max(this.config.tailBytes, 64_000),
    );
    if (pulled.exitCode === 0 && !pulled.timedOut && !pulled.aborted && !pulled.outputLimited) return undefined;
    if (this.dockerUnavailable(pulled))
      return {
        output: `Docker is unavailable, so the sandbox image "${image}" could not be pulled: ${pulled.stderrTail || "docker CLI not found"}`,
        data: { sandbox: "unavailable" },
      };
    const detail = [pulled.stdoutTail, pulled.stderrTail].filter(Boolean).join("\n");
    return {
      output: `Sandbox image "${image}" is not available on this host and could not be pulled${pulled.timedOut ? " (timed out)" : ""}. Pull it once with: docker pull ${image}${detail ? `\n\n${detail}` : ""}`,
      data: { sandbox: "image-missing" },
    };
  }

  async verify(input: SandboxVerifyInput): Promise<ToolResult> {
    // A folder project created with `gitInit: false` has no repository at all;
    // its source is `project.localPath`. Everything else keeps the repo path.
    const folderPath = sandboxFolderSource(input.project);
    const sourceData = folderPath ? { source: "localPath", localPath: folderPath } : {};
    const requestedRepo = input.repoName?.trim();
    const repoName = folderPath ? "" : (requestedRepo ?? input.project.configRepo);
    const ref = input.ref ?? input.project.branch;
    const unverified = (output: string, data: Record<string, unknown> = {}): ToolResult => ({
      ok: false,
      output,
      data: { verification: "unverified", fixable: false, repo: repoName, ref, ...sourceData, ...data },
    });
    const isLinkedRepo = (name: string): boolean =>
      name === input.project.configRepo || !!input.project.repositories?.some((r) => r.repo === name);
    const repo = parseRepoFullName(repoName);
    if (folderPath) {
      // An explicitly requested repository must still belong to this project;
      // the empty default simply means "read the folder".
      if (requestedRepo && !isLinkedRepo(requestedRepo))
        return unverified("Sandbox repository must be linked to this project", { stage: input.stage });
    } else if (!repo || !isLinkedRepo(repoName)) {
      return unverified("Sandbox repository must be linked to this project");
    }
    // A mock repository has no real source tree to execute: running a container
    // would prove nothing and would force a human approval for a simulation.
    // A folder source is real local code and is executed even when no GitHub
    // account is connected (the mock adapter is irrelevant to it).
    if (input.github.kind === "mock" && !folderPath)
      return {
        ok: true,
        output: `Simulation only: repository commands were not executed for ${repoName}@${ref}. Connect a real repository and Docker to run them.`,
        data: { verification: "simulated", sandbox: "mock", repo: repoName, ref, stage: input.stage },
      };
    let commands: ProjectCommands;
    try {
      commands = commandsFor(input.project);
    } catch (error) {
      // A stored command can be edited by hand (or restored from an older
      // backup). Treat an invalid one as "not verifiable" instead of letting
      // the exception escape the tool and fail the whole run.
      return unverified(
        `A configured sandbox command is invalid: ${error instanceof Error ? error.message : String(error)}`,
        { stage: input.stage },
      );
    }
    const selected = stageCommands(commands, input.stage);
    if (!selected.required)
      return unverified(
        `No ${input.stage} command is configured for this project. Set it in Project → Edit → Operations.`,
        {
          commands,
          stage: input.stage,
        },
      );
    if (!selected.commands.length)
      return unverified(`No commands are configured for ${input.stage} verification`, { commands });
    if (selected.commands.some(({ command }) => command.length > 1000 || command.includes("\0")))
      return unverified("A sandbox command is invalid or exceeds the 1000-character limit", { stage: input.stage });
    input.checkActive?.();
    if (input.signal?.aborted) return unverified("Sandbox execution was cancelled before it started");
    const image = this.config.image || stackImage(input.project);
    // The run below keeps `--pull=never`. The optional preflight only decides
    // whether the image should be checked/pulled explicitly, so a missing image
    // produces one actionable message instead of an opaque runtime failure.
    const imageProblem = await this.prepareImage(image, input.signal);
    if (imageProblem) return unverified(imageProblem.output, { stage: input.stage, image, ...imageProblem.data });
    let source: ExportedTree;
    try {
      if (folderPath) {
        source = await exportLocalFolderTree(folderPath);
      } else if (repo) {
        source = await exportGithubTree(input.github, repo, ref, input.expectedSha);
      } else {
        throw new Error(`Invalid repository name: ${repoName || "(empty)"}`);
      }
    } catch (error) {
      return unverified(
        `Could not prepare a safe sandbox source tree: ${error instanceof Error ? error.message : String(error)}`,
        {
          stage: input.stage,
        },
      );
    }
    await fsp.mkdir(this.config.workspaceRoot, { recursive: true, mode: 0o700 });
    const workspaceParent = await fsp.mkdtemp(join(this.config.workspaceRoot, "codevia-sandbox-"));
    await fsp.chmod(workspaceParent, 0o755);
    const workspace = join(workspaceParent, "work");
    try {
      await writeWorkspace(workspace, source.files);
      const networkMode = sandboxNetworkMode(input.project);
      const phases = sandboxPhases(selected.commands, networkMode);
      const persistentHome = phases.length > 1;
      const homeVolume = join(workspaceParent, "home");
      if (persistentHome) {
        await fsp.mkdir(homeVolume, { recursive: true, mode: 0o777 });
        await fsp.chmod(homeVolume, 0o777);
      }
      const dockerArgs = (phase: SandboxPhase): string[] => [
        "run",
        "--rm",
        "--pull=never",
        "--name",
        `codevia-${randomUUID()}`,
        `--network=${phase.network ? "bridge" : "none"}`,
        `--cpus=${this.config.cpus}`,
        `--memory=${bytes(this.config.memoryMb)}`,
        `--memory-swap=${bytes(this.config.memoryMb)}`,
        `--pids-limit=${this.config.pidsLimit}`,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--user=1000:1000",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=256m",
        ...cacheEnv(persistentHome),
        "--volume",
        `${workspace}:/workspace:rw`,
        ...(persistentHome ? ["--volume", `${homeVolume}:${SANDBOX_PERSISTENT_HOME}:rw`] : []),
        "--workdir",
        "/workspace",
        image,
        "/bin/sh",
        "-lc",
        sandboxScript(phase.steps),
      ];
      // Phases share one workspace and one wall-clock budget. A failing phase
      // stops the run, so an install failure is reported exactly as before.
      let result: DockerExecutionResult | undefined;
      let installPhaseOk = false;
      for (const phase of phases) {
        const elapsed = result?.durationMs ?? 0;
        const remaining = this.config.timeoutMs - elapsed;
        if (remaining < 1000) {
          result = { ...(result as DockerExecutionResult), exitCode: 124, timedOut: true };
          break;
        }
        const current = await this.config.runDocker(
          this.config.dockerBin,
          dockerArgs(phase),
          remaining,
          input.signal,
          this.config.tailBytes,
        );
        result = result
          ? {
              ...current,
              stdoutTail: joinTails(result.stdoutTail, current.stdoutTail, this.config.tailBytes),
              stderrTail: joinTails(result.stderrTail, current.stderrTail, this.config.tailBytes),
              durationMs: result.durationMs + current.durationMs,
            }
          : current;
        const phaseOk = current.exitCode === 0 && !current.timedOut && !current.aborted && !current.outputLimited;
        if (!phaseOk) break;
        if (phases.length > 1 && phase.network) installPhaseOk = true;
        input.checkActive?.();
      }
      if (!result) throw new Error("No sandbox commands were scheduled");
      input.checkActive?.();
      const succeeded = result.exitCode === 0 && !result.timedOut && !result.aborted && !result.outputLimited;
      const configuredStages = selected.commands.map((item) => item.stage);
      const dockerMissing =
        result.exitCode === 127 &&
        /Docker executable not found|Could not start Docker|docker: (?:command )?not found/i.test(result.stderrTail);
      // `--pull=never` keeps sandbox runs offline; when the host has not pulled
      // the image yet, say exactly what to run instead of a bare exit code.
      const imageMissing =
        !succeeded &&
        !dockerMissing &&
        /unable to find image|no such image|manifest unknown|pull access denied|image .*not found|reference does not exist/i.test(
          result.stderrTail,
        );
      const target = folderPath
        ? `local folder project "${input.project.slug}"`
        : `${repoName}@${source.sha.slice(0, 12)}`;
      const sourceNote = folderPath
        ? `This project has no git repository; the sandbox source was read directly from localPath (${folderPath}).`
        : "";
      // A failing `install` (or a timeout/output-limit) is an environment
      // problem, not a code defect: it must never trigger an agent fix loop.
      const failedStage = sandboxFailedStage(result);
      const fixable =
        !succeeded &&
        !imageMissing &&
        !dockerMissing &&
        result.exitCode !== 127 &&
        isFixableSandboxFailure(result, failedStage);
      const stageNote =
        !succeeded && !imageMissing
          ? !failedStage
            ? "Failing stage: unknown (the container reported no stage marker) — treated as not auto-fixable."
            : CODE_STAGES.has(failedStage)
              ? `Failing stage: ${failedStage} — project code failure (auto-fixable).`
              : failedStage === "install"
                ? networkMode === "none"
                  ? 'Failing stage: install — ran with --network=none, so the code was never tested (unverified). Not auto-fixed by code changes: enable "Network for the install step only" in Project → Edit → Operations, or vendor/pre-install dependencies.'
                  : "Failing stage: install — failed even with network access, so the code was never tested (unverified). Not auto-fixed by code changes: check the install command, lockfile and registry access."
                : `Failing stage: ${failedStage} — not attributed to project code, so no automatic fix loop will start.`
          : "";
      // `docker run` always keeps `--pull=never`; the only pull is the explicit
      // preflight. Say which policy was in effect so the message is exact.
      const pullNote =
        this.config.imagePull === "never"
          ? "docker run keeps --pull=never; pull it once, or set PROJECT_SANDBOX_IMAGE_PULL=missing"
          : `docker run keeps --pull=never and the explicit image step (PROJECT_SANDBOX_IMAGE_PULL=${this.config.imagePull}) did not leave it present`;
      const output = [
        imageMissing
          ? `Docker sandbox could not start: image "${image}" is not present on this host. Pull it with: docker pull ${image} (${pullNote}).`
          : `Docker sandbox ${succeeded ? "passed" : "failed"} for ${target} (exit ${result.exitCode}${result.timedOut ? ", timeout" : ""}${result.aborted ? ", cancelled" : ""}${result.outputLimited ? ", output limit" : ""}).`,
        sourceNote,
        networkMode === "install-only" && phases.length > 1
          ? `Network: install ran in its own container with --network=bridge${installPhaseOk ? "" : " (failed)"}; the remaining steps run offline with --network=none.`
          : "",
        stageNote,
        result.stdoutTail ? `stdout tail:\n${result.stdoutTail}` : "",
        result.stderrTail ? `stderr tail:\n${result.stderrTail}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const verification = imageMissing
        ? "unverified"
        : succeeded
          ? "passed"
          : result.exitCode === 127 || (failedStage === "install" && !result.timedOut && !result.aborted)
            ? // Dependencies never installed: no build/test step ran, so this
              // says nothing about the code. Never report it as a failed test.
              "unverified"
            : "failed";
      return {
        ok: succeeded,
        output,
        data: {
          verification,
          // Only test/build/lint failures are repairable by an agent.
          fixable,
          failedStage,
          fixableReason: succeeded
            ? undefined
            : fixable
              ? `project-code:${failedStage}`
              : result.timedOut
                ? "timeout"
                : result.outputLimited
                  ? "output-limit"
                  : failedStage
                    ? `environment:${failedStage}`
                    : "unknown-stage",
          // "unavailable" means no container ran (missing Docker CLI/daemon);
          // "image-missing" means the CLI worked but the image was never pulled;
          // local projects then stay unverified instead of executing anywhere
          // else. "docker" means the sandbox really ran.
          sandbox: dockerMissing ? "unavailable" : imageMissing ? "image-missing" : "docker",
          repo: repoName,
          ref,
          sha: source.sha,
          image,
          ...sourceData,
          stage: input.stage,
          commands: configuredStages,
          networkAccess: networkMode === "full",
          network: networkMode,
          ...(phases.length > 1 ? { installPhase: installPhaseOk ? "passed" : "failed" } : {}),
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          aborted: result.aborted,
          outputLimited: result.outputLimited,
          durationMs: result.durationMs,
          stdoutTail: result.stdoutTail,
          stderrTail: result.stderrTail,
        },
      };
    } catch (error) {
      return unverified(
        `Docker sandbox failed before verification: ${error instanceof Error ? error.message : String(error)}`,
        {
          sandbox: "docker",
          sha: source.sha,
          stage: input.stage,
        },
      );
    } finally {
      await fsp.rm(workspaceParent, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Execute one configured lifecycle command (used by explicit UI/tool requests). */
  async runCommand(input: Omit<SandboxVerifyInput, "stage"> & { stage: SandboxStage }): Promise<ToolResult> {
    return this.verify(input as SandboxVerifyInput);
  }
}
