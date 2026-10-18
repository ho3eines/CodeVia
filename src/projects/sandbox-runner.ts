import { spawn } from "node:child_process";
import { promises as fsp } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
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
import type { ToolResult } from "../tools/types.js";

export type SandboxStage = "test" | "build" | "lint" | "install" | "start";

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
  return {
    dockerBin: options.dockerBin ?? process.env.PROJECT_SANDBOX_DOCKER_BIN ?? "docker",
    image: options.image ?? process.env.PROJECT_SANDBOX_IMAGE,
    timeoutMs: options.timeoutMs ?? positiveNumber(process.env.PROJECT_SANDBOX_TIMEOUT_MS, 8 * 60_000, 10 * 60_000),
    memoryMb: options.memoryMb ?? positiveNumber(process.env.PROJECT_SANDBOX_MEMORY_MB, 1024, 16 * 1024),
    cpus: options.cpus ?? positiveNumber(process.env.PROJECT_SANDBOX_CPUS, 1, 8),
    pidsLimit: options.pidsLimit ?? Math.floor(positiveNumber(process.env.PROJECT_SANDBOX_PIDS_LIMIT, 128, 4096)),
    tailBytes:
      options.tailBytes ?? Math.floor(positiveNumber(process.env.PROJECT_SANDBOX_LOG_TAIL_BYTES, 12_000, 256_000)),
    workspaceRoot: resolve(options.workspaceRoot ?? process.env.PROJECT_SANDBOX_DIR ?? tmpdir()),
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
 * Executes project lifecycle commands only inside a disposable Docker
 * container. It deliberately has no host-shell fallback.
 */
export class SandboxRunner {
  private readonly config: ReturnType<typeof sandboxConfigFromEnv>;

  constructor(options: SandboxRunnerOptions = {}) {
    this.config = sandboxConfigFromEnv(options);
  }

  async verify(input: SandboxVerifyInput): Promise<ToolResult> {
    const repoName = input.repoName ?? input.project.configRepo;
    const ref = input.ref ?? input.project.branch;
    const unverified = (output: string, data: Record<string, unknown> = {}): ToolResult => ({
      ok: false,
      output,
      data: { verification: "unverified", fixable: false, repo: repoName, ref, ...data },
    });
    const repo = parseRepoFullName(repoName);
    if (
      !repo ||
      !(repoName === input.project.configRepo || input.project.repositories?.some((r) => r.repo === repoName))
    )
      return unverified("Sandbox repository must be linked to this project");
    const commands = commandsFor(input.project);
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
    let source: ExportedTree;
    try {
      source = await exportGithubTree(input.github, repo, ref, input.expectedSha);
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
      const network = input.project.settings?.sandboxNetworkAccess === true;
      const image = this.config.image || stackImage(input.project);
      const script = [
        "set -e",
        ...selected.commands.map(({ stage, command }) => `printf '\\n[CodeVia sandbox] ${stage}\\n'; ${command}`),
      ].join("\n");
      const containerName = `codevia-${randomUUID()}`;
      const args = [
        "run",
        "--rm",
        "--pull=never",
        "--name",
        containerName,
        `--network=${network ? "bridge" : "none"}`,
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
        "--env",
        "HOME=/tmp",
        "--env",
        "TMPDIR=/tmp",
        "--env",
        "CI=true",
        "--env",
        "npm_config_cache=/tmp/npm-cache",
        "--env",
        "PIP_CACHE_DIR=/tmp/pip-cache",
        "--env",
        "GOCACHE=/tmp/go-build",
        "--env",
        "GOMODCACHE=/tmp/go-mod",
        "--env",
        "CARGO_HOME=/tmp/cargo",
        "--env",
        "POETRY_CACHE_DIR=/tmp/poetry-cache",
        "--volume",
        `${workspace}:/workspace:rw`,
        "--workdir",
        "/workspace",
        image,
        "/bin/sh",
        "-lc",
        script,
      ];
      const result = await this.config.runDocker(
        this.config.dockerBin,
        args,
        this.config.timeoutMs,
        input.signal,
        this.config.tailBytes,
      );
      input.checkActive?.();
      const succeeded = result.exitCode === 0 && !result.timedOut && !result.aborted && !result.outputLimited;
      const configuredStages = selected.commands.map((item) => item.stage);
      const output = [
        `Docker sandbox ${succeeded ? "passed" : "failed"} for ${repoName}@${source.sha.slice(0, 12)} (exit ${result.exitCode}${result.timedOut ? ", timeout" : ""}${result.aborted ? ", cancelled" : ""}${result.outputLimited ? ", output limit" : ""}).`,
        result.stdoutTail ? `stdout tail:\n${result.stdoutTail}` : "",
        result.stderrTail ? `stderr tail:\n${result.stderrTail}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const verification = succeeded ? "passed" : result.exitCode === 127 ? "unverified" : "failed";
      return {
        ok: succeeded,
        output,
        data: {
          verification,
          fixable: !succeeded && result.exitCode !== 127 && !result.aborted,
          sandbox: "docker",
          repo: repoName,
          ref,
          sha: source.sha,
          stage: input.stage,
          commands: configuredStages,
          networkAccess: network,
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
