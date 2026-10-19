// BoxLite (aka Litebox) implementation of SandboxExecutor.
//
// BoxLite (https://github.com/boxlite-ai/boxlite, npm: @boxlite-ai/boxlite)
// is a local-first micro-VM sandbox — each box gets its own kernel via
// libkrun. Hardware-level isolation, no daemon required, ships a
// Rust core with a Node.js binding. The selling point vs LocalSubprocess:
// real isolation against `rm -rf /` from a prompt-injected agent without
// needing the operator to run docker.
//
// Driver dep is a peer with peerDependenciesMeta.optional — caller installs:
//   pnpm add @boxlite-ai/boxlite
//
// SDK shape (as of @boxlite-ai/boxlite ^0.8):
//   const box = new SimpleBox({ image, env, volumes, ... })
//   await box.exec("sh", ["-c", command], env, { timeoutSecs })
//   await box.copyIn(hostPath, containerPath)
//   await box.copyOut(containerPath, hostPath)
//   await box.stop()
//
// Lazy-create: BoxLite's box is created on first exec(), so any
// configuration that needs to land BEFORE creation (volumes, image, env)
// must be collected via setEnvVars / mountMemoryStore / ctor opts before
// the first exec/readFile/writeFile call. We track this via `created` —
// once true, mutating ops that affect ctor opts throw.
//
// Image: the server image (`SANDBOX_IMAGE`, default node:22-bookworm) with
// the LITEBOX_* resources, or the catalog image of the environment
// (docs/plans/environments.md, 1.6-1.7): an OCI layout passed to BoxLite as
// `rootfsPath`, or a registry reference pinned by digest, with the catalog's
// disk, memory and CPUs. The digest of a layout is checked against its
// index.json right before the VM boots. Agent commands run in bash when the
// image has it; the server image keeps POSIX sh.

import type {
  ProcessHandle,
  SandboxDuplexProcess,
  SandboxDuplexProcessPort,
  SandboxDuplexProcessSpec,
  SandboxEgress,
  SandboxEnvironmentImage,
  SandboxEnvironmentNetworking,
  SandboxEnvironmentSnapshot,
  SandboxEnvironmentSnapshotPort,
  SandboxEnvironmentSpec,
  SandboxExecutor,
  SandboxFactory,
  SandboxPackageManager,
  SandboxShell,
  SandboxVmResources,
} from "@open-managed-agents/sandbox";
import {
  buildEnvironmentSetupScript,
  environmentPackageLists,
  environmentSetupFailure,
  PACKAGE_MANAGER_HOSTS,
  SandboxEnvironmentError,
} from "@open-managed-agents/sandbox";
import { readOciIndexDigest } from "@open-managed-agents/sandbox/environment";
import { promises as dns } from "node:dns";
import { promises as fs, mkdirSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join, posix, resolve } from "node:path";
import { constants as osConstants, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { getLogger } from "@open-managed-agents/observability";

// Resolved per call: main-node imports this module (components.ts) before
// node-foundation installs the root logger, and a child taken at import time
// would stay bound to the bootstrap noop logger for the process lifetime.
const moduleLogger = () => getLogger("litebox-sandbox");

/** Package installs run once per VM; apt update + install on a cold mirror
 *  cache routinely takes a minute or more. */
const SETUP_TIMEOUT_SECS = 600;
/** Variables `setOutboundContext` sets; the package install needs them to
 *  reach registries through the vault proxy. */
const OUTBOUND_PROXY_ENV: ReadonlySet<string> = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "CURL_CA_BUNDLE",
]);

type LiteBoxNetwork =
  | { mode: "enabled"; allowNet?: string[] }
  | { mode: "disabled" };

const WORKSPACE = "/workspace";
const DEFAULT_SERVER_IMAGE = "node:22-bookworm";
/** Looks for bash once on a catalog image whose manifest names no shell. */
const BASH_PROBE = "command -v bash >/dev/null 2>&1";

/** How the box is created, fixed once per sandbox: the VM snapshot states it. */
interface BoxPlan {
  /** What SimpleBox boots: an OCI layout, or an image reference. */
  source: { rootfsPath: string } | { image: string };
  /** The catalog image; null for the server image. */
  catalogImage: SandboxEnvironmentImage | null;
  facts: SandboxEnvironmentSnapshot["image"];
  /** The image as the "creating box" log line names it. */
  label: string;
  /** Shell of agent commands; null makes the box look for bash when it boots. */
  shell: SandboxShell | null;
  network: LiteBoxNetwork;
  networking: SandboxEnvironmentNetworking;
  resources: SandboxVmResources;
  packages: Partial<Record<SandboxPackageManager, string[]>>;
}

export interface LiteBoxSandboxOptions {
  /** Server image, used when the environment has no catalog image.
   *  Default: `node:22-bookworm` (includes git for Managed repository resources). */
  image?: string;
  /** Optional VM resource limits; a catalog image brings its own. */
  memoryMib?: number;
  cpus?: number;
  /** Root disk size of the VM in GB. BoxLite 0.9.0 sizes it to the image
   *  by default (node:22-bookworm: 1.3 GB with ~120 MB free), too small for
   *  agent CLIs installed as environment packages. */
  diskSizeGb?: number;
  /** Default per-call timeout (ms). */
  defaultTimeoutMs?: number;
  /** How long a duplex process kill waits for BoxLite to deliver the signal,
   *  and then for the process to exit, before it warns (ms). Default 2000. */
  killTimeoutMs?: number;
  /** Logger for debug/warn output. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
  /** Optional name (must be unique). */
  name?: string;
  /** Memory blob root on the host — used by mountMemoryStore for the
   *  per-storeId source dir. Falls back to `process.env.MEMORY_BLOB_DIR`
   *  when omitted (back-compat for prior deploys). */
  memoryRoot?: string;
  /** Per-session outputs root on the host — used by mountSessionOutputs.
   *  Falls back to `process.env.FILES_BLOB_DIR` when omitted. */
  outputsRoot?: string;
  /** Host-owned lifecycle root for copy staging. The factory binds this to
   *  the session workdir so crash leftovers are reaped with the session. */
  scratchRoot?: string;
  /** Managed Environment applied when the box is created: packages are
   *  installed right after boot, networking becomes the box egress policy,
   *  and a catalog image replaces the server image and its resources. */
  environment?: SandboxEnvironmentSpec;
  /** Host-side IPv4 lookup for allowed hosts pinned in the guest's
   *  /etc/hosts. Default: the host resolver (`dns.lookup`). */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

const lookupIPv4 = async (hostname: string): Promise<string[]> =>
  (await dns.lookup(hostname, { all: true, family: 4 })).map(({ address }) => address);

interface LiteBoxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}
interface LiteBoxNativeStream {
  next(): Promise<string | null>;
}
interface LiteBoxNativeStdin {
  write(data: Buffer): Promise<void>;
  close(): Promise<void>;
}
/** Streaming execution of the native binding (`JsExecution` in 0.9.0). */
interface LiteBoxNativeExecution {
  stdin(): Promise<LiteBoxNativeStdin>;
  stdout(): Promise<LiteBoxNativeStream>;
  stderr(): Promise<LiteBoxNativeStream>;
  wait(): Promise<{ exitCode: number }>;
  kill(): Promise<void>;
  signal(signal: number): Promise<void>;
}
interface LiteBoxNativeBox {
  exec(
    command: string,
    args: string[],
    env: Array<[string, string]>,
    tty: boolean,
    user: string | null,
    timeoutSecs: number | null,
    workingDir: string,
  ): Promise<LiteBoxNativeExecution>;
}
interface LiteBoxInstance {
  exec(
    cmd: string,
    args: string[],
    env?: Record<string, string>,
    options?: { cwd?: string; user?: string; timeoutSecs?: number },
  ): Promise<LiteBoxExecResult>;
  copyIn(hostPath: string, containerDest: string, options?: unknown): Promise<void>;
  copyOut(containerSrc: string, hostDest: string, options?: unknown): Promise<void>;
  stop(): Promise<void>;
  /** SimpleBox (0.9.0) keeps the native box behind this internal accessor;
   *  its `exec` is the only streaming exec the SDK has. */
  _ensureBox?(): Promise<LiteBoxNativeBox>;
}

export class LiteBoxSandbox implements SandboxExecutor, SandboxDuplexProcessPort, SandboxEnvironmentSnapshotPort {
  private envVars: Record<string, string> = {};
  private commandSecrets: Array<{ prefix: string; secrets: Record<string, string> }> = [];
  private volumes: Array<{ hostPath: string; guestPath: string; readOnly?: boolean }> = [];
  private boxPromise: Promise<LiteBoxInstance> | null = null;
  private logger: NonNullable<LiteBoxSandboxOptions["logger"]>;
  private tmpRoot: string;
  private plan: BoxPlan | null = null;
  /** What the booted box answered when the plan left the shell open. */
  private probedShell: SandboxShell | null = null;
  private ready: { readyAt: string; readyMs: number } | null = null;

  constructor(private opts: LiteBoxSandboxOptions = {}) {
    this.logger = opts.logger ?? {
      warn: (msg) => moduleLogger().warn({}, msg),
      log: (msg) => moduleLogger().info(msg),
    };
    // Per-instance host scratch dir for copyIn / copyOut staging. Cleaned
    // up on destroy.
    this.tmpRoot = opts.scratchRoot
      ? join(resolve(opts.scratchRoot), ".openma", `litebox-scratch-${Buffer.from(randomBytes(6)).toString("hex")}`)
      : join(tmpdir(), `oma-litebox-${Buffer.from(randomBytes(6)).toString("hex")}`);
    mkdirSync(this.tmpRoot, { recursive: true });
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const box = await this.ensureBox();
    const env = this.buildEnv(command);
    const timeoutMs = timeout ?? this.opts.defaultTimeoutMs ?? 120_000;
    try {
      const r = await box.exec(this.agentShell() ?? "sh", ["-c", command], env, {
        cwd: WORKSPACE,
        timeoutSecs: Math.max(1, Math.ceil(timeoutMs / 1000)),
      });
      const stderr = stripRuntimeNoise(r.stderr);
      const separator = r.stdout.length > 0 && !r.stdout.endsWith("\n") ? "\n" : "";
      const combined =
        (r.stdout + (stderr ? `${separator}${stderr}` : "")).replace(/\s+$/, "") +
        (r.exitCode !== 0 ? `\n[exit ${r.exitCode}]` : "");
      return combined;
    } catch (err) {
      return `[error: ${(err as Error).message}]`;
    }
  }

  /**
   * Live stdio process inside the VM, for protocol runtimes such as ACP.
   * No harness of this platform starts one since the ACP harnesses were
   * removed (D41); the port method stays. The process gets
   * the sandbox env (`setEnvVars`) overlaid with `spec.env`, runs without a
   * timeout and lives until it exits, is killed, or the box stops. Both
   * output streams are drained eagerly: BoxLite's `wait()` does not settle
   * while output is unread.
   */
  async spawnDuplexProcess(spec: SandboxDuplexProcessSpec): Promise<SandboxDuplexProcess> {
    const box = await this.ensureBox();
    if (typeof box._ensureBox !== "function") {
      throw new Error(
        "LiteBoxSandbox: this @boxlite-ai/boxlite build has no streaming exec, " +
        "so duplex (ACP) processes are unavailable",
      );
    }
    const native = await box._ensureBox();
    const env = Object.entries({ ...this.envVars, ...spec.env })
      .filter((entry): entry is [string, string] => typeof entry[1] === "string");
    const execution = await native.exec(
      spec.command,
      spec.args ?? [],
      env,
      false,
      null,
      null,
      spec.cwd ? this.normalise(spec.cwd) : "/workspace",
    );
    const [stdin, stdout, stderr] = await Promise.all([
      execution.stdin(),
      execution.stdout(),
      execution.stderr(),
    ]);
    let finished = false;
    const killTimeoutMs = this.opts.killTimeoutMs ?? 2_000;
    const exited = execution.wait().then(({ exitCode }) => {
      finished = true;
      return exitCode < 0
        ? { code: null, signal: signalName(-exitCode) }
        : { code: exitCode, signal: null };
    });
    return {
      stdin: new WritableStream<Uint8Array>({
        write: (chunk) => stdin.write(Buffer.from(chunk)),
        close: () => stdin.close(),
        abort: () => stdin.close(),
      }),
      stdout: nativeReadable(stdout),
      stderr: nativeReadable(stderr, stripRuntimeNoise),
      // BoxLite 0.9.0 (checked in a VM, 2026-10-16): signal() and kill() of a
      // streaming exec never settle and deliver nothing, the process lives
      // until the box stops. Closing stdin does reach it, and a stdio agent
      // (ACP) exits on EOF, so kill closes stdin first, sends the signal for
      // a BoxLite that delivers it, and warns when the process outlives both.
      kill: async (signal = "SIGTERM") => {
        // The ACP spawner passes ChildHandle signals through, so any name
        // can arrive here even though the port type lists two.
        const number = osConstants.signals[signal as keyof typeof osConstants.signals];
        if (typeof number !== "number") throw new Error(`LiteBoxSandbox: unknown signal ${signal}`);
        if (finished) return;
        await stdin.close().catch(() => {});
        const sent = signal === "SIGKILL" ? execution.kill() : execution.signal(number);
        let delivered: boolean;
        try {
          delivered = await settlesWithin(sent, killTimeoutMs);
        } catch (err) {
          if (!finished) throw err;
          return;
        }
        if (delivered || finished) return;
        if (!(await settlesWithin(exited, killTimeoutMs))) {
          this.logger.warn(
            `duplex process ${spec.command} did not exit after ${signal}: BoxLite did not deliver ` +
            "the signal and closing stdin did not end it; it stops with the box",
          );
        }
      },
      exited,
    };
  }

  /**
   * Facts of the VM for the "Environment" prompt block (plan 4.5): the image
   * key and digest, the shell, the networking and the egress the box gets,
   * the environment packages and the resources. Before the box boots these
   * are the facts it will boot with and `vm` is null; reading them never
   * boots it. Every call returns a fresh copy.
   */
  environmentSnapshot(): SandboxEnvironmentSnapshot {
    const plan = this.boxPlan();
    return {
      image: { ...plan.facts },
      shell: this.agentShell(),
      workingDirectory: WORKSPACE,
      networking: plan.networking.type === "limited"
        ? { ...plan.networking, allowedHosts: [...plan.networking.allowedHosts] }
        : { type: "unrestricted" },
      egress: egressOf(plan.network),
      packages: Object.fromEntries(
        Object.entries(plan.packages).map(([manager, names]) => [manager, [...names]]),
      ),
      resources: { ...plan.resources },
      vm: this.ready === null ? null : { ...this.ready },
    };
  }

  async startProcess(_command: string): Promise<ProcessHandle | null> {
    // BoxLite's exec is blocking; backgrounding would need a separate API
    // (and a ProcessHandle bookkeeping pass). Returning null keeps the
    // harness's startProcess callers correct — they fall back to exec
    // with a longer timeout.
    return null;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.push({ prefix: commandPrefix, secrets });
  }

  async setOutboundContext(_opts?: { tenantId: string; sessionId: string }): Promise<void> {
    // BoxLite supports network — we route via env vars same as the
    // LocalSubprocess path. The CA cert lives on the host though, so
    // copy it into the box on first exec via ensureBox.
    const proxyUrl = process.env.OMA_VAULT_PROXY_URL;
    const caCertPath = process.env.OMA_VAULT_CA_CERT;
    if (!proxyUrl || !caCertPath) return;

    const inBoxCaPath = "/etc/ssl/oma-vault-ca.crt";
    await this.setEnvVars({
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NODE_EXTRA_CA_CERTS: inBoxCaPath,
      SSL_CERT_FILE: inBoxCaPath,
      CURL_CA_BUNDLE: inBoxCaPath,
    });
    // Schedule the CA upload on first ensureBox call. We keep it as a
    // pending action because the box may not exist yet.
    this.pendingCaUpload = { hostPath: caCertPath, guestPath: inBoxCaPath };
  }

  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    if (this.boxPromise) {
      throw new Error(
        "LiteBoxSandbox.mountMemoryStore: box already created — mounts must " +
        "be configured before the first exec/readFile/writeFile call",
      );
    }
    const memoryRoot = this.opts.memoryRoot
      ? resolve(this.opts.memoryRoot)
      : process.env.MEMORY_BLOB_DIR
        ? resolve(process.env.MEMORY_BLOB_DIR)
        : null;
    if (!memoryRoot) {
      throw new Error(
        "LiteBoxSandbox.mountMemoryStore: memoryRoot not provided (constructor) " +
        "and MEMORY_BLOB_DIR env var not set — set one of them so mounts can " +
        "find the on-disk content",
      );
    }
    if (!this.opts.memoryRoot && process.env.MEMORY_BLOB_DIR) {
      this.logger.warn(
        "LiteBoxSandbox.mountMemoryStore falling back to MEMORY_BLOB_DIR env var; " +
        "wire ctx.memoryRoot through SandboxFactoryContext to remove the warning",
      );
    }
    const hostPath = join(memoryRoot, opts.storeId);
    mkdirSync(hostPath, { recursive: true });
    const guestPath = `/mnt/memory/${opts.storeName}`;
    this.volumes.push({ hostPath, guestPath, readOnly: opts.readOnly });
  }

  sessionOutputMountCapabilities(): { durability: "durable" } | null {
    return this.opts.outputsRoot || process.env.FILES_BLOB_DIR
      ? { durability: "durable" }
      : null;
  }

  async mountSessionOutputs(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    if (this.boxPromise) {
      throw new Error(
        "LiteBoxSandbox.mountSessionOutputs: box already created — mounts must " +
        "be configured before the first exec/readFile/writeFile call",
      );
    }
    const outputsRoot = this.opts.outputsRoot
      ? resolve(this.opts.outputsRoot)
      : process.env.FILES_BLOB_DIR
        ? resolve(process.env.FILES_BLOB_DIR)
        : null;
    if (!outputsRoot) {
      throw new Error(
        "LiteBoxSandbox.mountSessionOutputs: outputsRoot not provided (constructor) " +
        "and FILES_BLOB_DIR env var not set — set one of them so mounts have " +
        "a host directory to bind",
      );
    }
    if (!this.opts.outputsRoot && process.env.FILES_BLOB_DIR) {
      this.logger.warn(
        "LiteBoxSandbox.mountSessionOutputs falling back to FILES_BLOB_DIR env var; " +
        "wire ctx.outputsRoot through SandboxFactoryContext to remove the warning",
      );
    }
    const hostPath = join(outputsRoot, opts.tenantId, opts.sessionId);
    mkdirSync(hostPath, { recursive: true });
    this.volumes.push({ hostPath, guestPath: "/mnt/session/outputs", readOnly: false });
  }

  async readFile(path: string): Promise<string> {
    const box = await this.ensureBox();
    const tmp = join(this.tmpRoot, `read-${Buffer.from(randomBytes(6)).toString("hex")}`);
    try {
      await this.copyOutOfBox(box, this.normalise(path), tmp);
      return await fs.readFile(tmp, "utf8");
    } finally {
      await removeBestEffort(tmp);
    }
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const box = await this.ensureBox();
    const tmp = join(this.tmpRoot, `read-${Buffer.from(randomBytes(6)).toString("hex")}`);
    try {
      await this.copyOutOfBox(box, this.normalise(path), tmp);
      const buf = await fs.readFile(tmp);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    } finally {
      await removeBestEffort(tmp);
    }
  }

  async writeFile(path: string, content: string): Promise<string> {
    const box = await this.ensureBox();
    const tmp = join(this.tmpRoot, `write-${Buffer.from(randomBytes(6)).toString("hex")}`);
    const target = this.normalise(path);
    await fs.writeFile(tmp, content, "utf8");
    try {
      await this.copyIntoTarget(box, tmp, target);
    } finally {
      await removeBestEffort(tmp);
    }
    return target;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const box = await this.ensureBox();
    const tmp = join(this.tmpRoot, `write-${Buffer.from(randomBytes(6)).toString("hex")}`);
    const target = this.normalise(path);
    await fs.writeFile(tmp, bytes);
    try {
      await this.copyIntoTarget(box, tmp, target);
    } finally {
      await removeBestEffort(tmp);
    }
    return target;
  }

  async destroy(): Promise<void> {
    if (this.boxPromise) {
      try {
        const box = await this.boxPromise;
        await box.stop();
      } catch (err) {
        this.logger.warn(`destroy stop failed: ${(err as Error).message}`);
      } finally {
        this.boxPromise = null;
        this.ready = null;
      }
    }
    await removeBestEffort(this.tmpRoot, true);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private pendingCaUpload: { hostPath: string; guestPath: string } | null = null;

  /** Image, resources, egress and packages of the box, worked out once:
   *  the box boots with exactly what the snapshot states. */
  private boxPlan(): BoxPlan {
    if (this.plan) return this.plan;
    const environment = this.opts.environment;
    const catalogImage = environment?.image ?? null;
    const serverImage = this.opts.image ?? DEFAULT_SERVER_IMAGE;
    let source: BoxPlan["source"];
    let facts: BoxPlan["facts"];
    if (catalogImage === null) {
      source = { image: serverImage };
      facts = { key: null, reference: serverImage, digest: null, manifestSha256: null, manifest: null };
    } else {
      const reference = catalogImage.source.type === "registry" ? catalogImage.source.reference : null;
      source = catalogImage.source.type === "oci"
        ? { rootfsPath: catalogImage.source.dir }
        : { image: catalogImage.source.reference };
      facts = {
        key: catalogImage.key,
        reference,
        digest: catalogImage.digest,
        manifestSha256: catalogImage.manifestSha256,
        // Every snapshot shares one copy, frozen, which the host cannot edit either.
        manifest: catalogImage.manifest === null ? null : deepFreeze(structuredClone(catalogImage.manifest)),
      };
    }
    this.plan = {
      source,
      catalogImage,
      facts,
      label: catalogImage === null ? serverImage : `${catalogImage.key} ${catalogImage.digest}`,
      // The server image keeps POSIX sh, as before the catalog.
      shell: catalogImage === null ? "sh" : catalogImage.shell,
      network: liteBoxNetwork(environment?.networking, outboundProxyHosts()),
      networking: environment?.networking ?? { type: "unrestricted" },
      resources: {
        diskGb: catalogImage?.resources.diskGb ?? this.opts.diskSizeGb ?? null,
        memoryMib: catalogImage?.resources.memoryMib ?? this.opts.memoryMib ?? null,
        cpus: catalogImage?.resources.cpus ?? this.opts.cpus ?? null,
      },
      packages: Object.fromEntries(
        environmentPackageLists(environment?.packages).map(({ manager, names }) => [manager, names]),
      ),
    };
    return this.plan;
  }

  /** Null until a box without a planned shell has looked for bash. */
  private agentShell(): SandboxShell | null {
    return this.boxPlan().shell ?? this.probedShell;
  }

  private async ensureBox(): Promise<LiteBoxInstance> {
    if (this.boxPromise) return this.boxPromise;
    this.boxPromise = (async () => {
      type LiteBoxModule = {
        SimpleBox: new (options: {
          image?: string;
          rootfsPath?: string;
          memoryMib?: number;
          cpus?: number;
          diskSizeGb?: number;
          name?: string;
          volumes?: Array<{ hostPath: string; guestPath: string; readOnly?: boolean }>;
          network?: LiteBoxNetwork;
        }) => LiteBoxInstance;
      };
      const mod = (await import(
        /* @vite-ignore */ "@boxlite-ai/boxlite" as string,
      ).catch((err) => {
        throw new Error(
          `LiteBoxSandbox: failed to load '@boxlite-ai/boxlite' — ` +
          `pnpm add @boxlite-ai/boxlite (cause: ${String(err)})`,
        );
      })) as LiteBoxModule;
      const plan = this.boxPlan();
      if (plan.catalogImage !== null) await verifyCatalogLayout(plan.catalogImage);
      const networking = this.opts.environment?.networking;
      this.logger.log(`creating box (image=${plan.label}, network=${describeNetwork(plan.network)})`);
      for (const warning of allowlistWarnings(networking, plan.network)) this.logger.warn(warning);
      const startedAt = Date.now();
      const box = new mod.SimpleBox({
        ...plan.source,
        memoryMib: plan.resources.memoryMib ?? undefined,
        cpus: plan.resources.cpus ?? undefined,
        diskSizeGb: plan.resources.diskGb ?? undefined,
        name: this.opts.name,
        volumes: this.volumes,
        network: plan.network,
      });
      try {
        await this.initializeBox(box, networking);
      } catch (err) {
        await box.stop().catch(() => {});
        throw err;
      }
      const readyMs = Date.now() - startedAt;
      this.ready = { readyAt: new Date().toISOString(), readyMs };
      this.logger.log(`box ready in ${readyMs} ms`);
      return box;
    })();
    return this.boxPromise;
  }

  private async initializeBox(
    box: LiteBoxInstance,
    networking: SandboxEnvironmentNetworking | undefined,
  ): Promise<void> {
    // The first exec creates and boots the box: BoxLite spawns boxlite-shim
    // then, and the shim keeps the environment it was spawned with.
    const workspace = await withShimDnsWorkaround(
      process.env,
      () => box.exec("mkdir", ["-p", "/workspace"]),
      () => this.logger.log(
        "GODEBUG=netdns=go set while the box boots, for boxlite-shim: its static glibc " +
        "getaddrinfo crashes the VM on the first guest DNS query",
      ),
    );
    if (workspace.exitCode !== 0) {
      throw new Error(
        `LiteBoxSandbox could not initialize /workspace: ${stripRuntimeNoise(workspace.stderr) || workspace.stdout}`,
      );
    }
    if (this.boxPlan().shell === null) {
      const probe = await box.exec("sh", ["-c", BASH_PROBE]);
      this.probedShell = probe.exitCode === 0 ? "bash" : "sh";
    }
    const pinnable = [...(environmentAllowedHosts(networking) ?? [])]
      .filter((host) => !host.startsWith("*.") && isIP(host) === 0);
    if (pinnable.length > 0) await this.pinAllowedHosts(box, pinnable);
    // Apply pending CA cert upload now that the box exists (a no-op exec
    // forces lazy creation per BoxLite's contract).
    if (this.pendingCaUpload) {
      const { hostPath, guestPath } = this.pendingCaUpload;
      try {
        await box.copyIn(hostPath, guestPath);
      } catch (err) {
        this.logger.warn(
          `vault CA cert upload failed (${(err as Error).message}); ` +
          `outbound TLS through oma-vault will fail with cert errors`,
        );
      }
    }
    const packages = this.opts.environment?.packages;
    const script = buildEnvironmentSetupScript(packages);
    if (script === null) return;
    const summary = environmentPackageLists(packages)
      .map(({ manager, names }) => `${manager}: ${names.join(" ")}`)
      .join("; ");
    this.logger.log(`installing environment packages (${summary})`);
    const startedAt = Date.now();
    // Install scripts are third-party code (npm/pip postinstall): they get the
    // outbound proxy settings only, never other sandbox variables such as
    // Vault secrets set for the agent.
    const setup = await box.exec("sh", ["-c", script], this.installEnv(), {
      cwd: "/workspace",
      timeoutSecs: SETUP_TIMEOUT_SECS,
    });
    if (setup.exitCode !== 0) {
      const separator = setup.stdout.endsWith("\n") ? "" : "\n";
      const output = `${setup.stdout}${separator}${stripRuntimeNoise(setup.stderr)}`.trim();
      const hint = networking?.type === "limited" && !networking.allowPackageManagers
        ? " (networking is limited and package managers are not allowed)"
        : "";
      const failure = environmentSetupFailure(output, setup.exitCode);
      // The host tells the user which manager failed from `packages`; the
      // message stays English for the server log.
      throw new SandboxEnvironmentError(
        "packages_failed",
        `LiteBoxSandbox: environment packages failed to install (exit ${setup.exitCode})${hint}: ` +
        failure.outputTail,
        failure,
      );
    }
    this.logger.log(`environment packages installed in ${Date.now() - startedAt} ms`);
  }

  /**
   * BoxLite 0.9.0 answers guest DNS for an allowlist from zones it builds
   * in a Go map, so their order changes per box. Matching is first suffix
   * match: the zone of an apex host (pypi.org, rubygems.org → "org.") can
   * come before the zone of deb.debian.org ("debian.org.") and answer
   * 0.0.0.0 for it. Checked in VMs with the package registries allowed:
   * deb.debian.org resolved to 0.0.0.0 in 4 of 8 boxes and apt failed;
   * every box sinkholed some allowed registry. Exact allowed names resolved
   * on the host and pinned in the guest's /etc/hosts skip that answer;
   * egress is still filtered by SNI / Host header on ports 80 and 443.
   * Wildcards cannot be pinned, and the vault proxy host is left to
   * BoxLite's DNS (both are warned about when the box is created). Pinned
   * addresses are resolved once, when the box starts: a CDN host
   * (deb.debian.org is Fastly) may move while a long-lived box keeps them.
   */
  private async pinAllowedHosts(box: LiteBoxInstance, hosts: string[]): Promise<void> {
    const resolveHost = this.opts.resolveHost ?? lookupIPv4;
    const resolved = await Promise.allSettled(hosts.map((host) => resolveHost(host)));
    const lines: string[] = [];
    let pinned = 0;
    resolved.forEach((result, index) => {
      const host = hosts[index]!;
      if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        this.logger.warn(`allowed host ${host} did not resolve on the host (${reason}); it is not pinned`);
        return;
      }
      if (result.value.length > 0) pinned += 1;
      for (const address of result.value) lines.push(`${address} ${host}`);
    });
    if (lines.length === 0) return;
    const written = await box.exec("sh", ["-c", 'printf "%s\\n" "$@" >> /etc/hosts', "sh", ...lines]);
    if (written.exitCode !== 0) {
      this.logger.warn(
        `could not pin allowed hosts in /etc/hosts: ${`${written.stdout}\n${stripRuntimeNoise(written.stderr)}`.trim()}`,
      );
      return;
    }
    this.logger.log(`pinned ${pinned} allowed host(s) in /etc/hosts`);
  }

  /**
   * /workspace/foo → /workspace/foo (BoxLite has no opinion on workdir
   * by default; the harness assumes /workspace exists). We don't rewrite
   * paths the way LocalSubprocess does because BoxLite IS isolated, and
   * /workspace is just a regular dir inside the VM's rootfs.
   */
  private normalise(p: string): string {
    if (p.startsWith("/")) return p;
    return `/workspace/${p}`;
  }

  private installEnv(): Record<string, string> {
    return Object.fromEntries(
      Object.entries(this.envVars).filter(([name]) => OUTBOUND_PROXY_ENV.has(name)),
    );
  }

  private buildEnv(command: string): Record<string, string> {
    const out: Record<string, string> = { ...this.envVars };
    for (const { prefix, secrets } of this.commandSecrets) {
      if (command.startsWith(prefix)) Object.assign(out, secrets);
    }
    return out;
  }

  /** tmpfs mounts of the box container; copyIn and copyOut do not see them. */
  private static readonly TMPFS_MOUNTS = ["/tmp"];
  /** Staging directory on the ext4 root file system, visible to both sides. */
  private static readonly STAGING_DIR = "/var/tmp";

  /**
   * The path lies under a mount of the container that runs `exec`: a volume
   * (session outputs, memory stores) or its tmpfs /tmp. BoxLite copyIn and
   * copyOut work on the ext4 root file system and do not see these mounts
   * (/proc/mounts in the box, 2026-10-16: "/dev/vda /", "tmpfs /tmp",
   * "virtiofs /mnt/session/outputs"). The `write` tool put itogi.md under the
   * outputs mount: bash never saw it and it never reached the session outputs.
   * Such paths go through a staging file in /var/tmp (ext4) and a `cat` inside
   * the container, so links resolve inside the VM and never on the host.
   */
  private hiddenByMount(target: string): boolean {
    const path = posix.normalize(target);
    const roots = [...LiteBoxSandbox.TMPFS_MOUNTS, ...this.volumes.map((volume) => volume.guestPath)];
    return roots.some((guestPath) => {
      const root = posix.normalize(guestPath).replace(/\/+$/, "");
      return path === root || path.startsWith(`${root}/`);
    });
  }

  private stagingPath(kind: "read" | "write"): string {
    return `${LiteBoxSandbox.STAGING_DIR}/.oma-${kind}-${Buffer.from(randomBytes(6)).toString("hex")}`;
  }

  /** Time limit of the in-container copy: a FIFO or a stuck mount must not hold the turn. */
  private copyTimeoutSecs(): number {
    return Math.max(1, Math.ceil((this.opts.defaultTimeoutMs ?? 120_000) / 1000));
  }

  private async copyIntoTarget(box: LiteBoxInstance, hostPath: string, target: string): Promise<void> {
    if (!this.hiddenByMount(target)) {
      await this.copyIntoBox(box, hostPath, target);
      return;
    }
    const staged = this.stagingPath("write");
    try {
      await this.copyIntoBox(box, hostPath, staged);
      const moved = await box.exec(
        "sh",
        [
          "-c",
          'if [ -p "$2" ]; then echo "$2 is a FIFO" >&2; exit 1; fi; mkdir -p "$(dirname "$2")" && cat "$1" > "$2"',
          "sh",
          staged,
          target,
        ],
        {},
        { timeoutSecs: this.copyTimeoutSecs() },
      );
      if (moved.exitCode !== 0) {
        throw new Error(`LiteBoxSandbox could not write ${target}: ${(moved.stderr || moved.stdout).trim()}`);
      }
    } finally {
      await box.exec("rm", ["-f", staged]).catch(() => undefined);
    }
  }

  private async copyOutOfBox(box: LiteBoxInstance, source: string, hostPath: string): Promise<void> {
    if (!this.hiddenByMount(source)) {
      await box.copyOut(source, hostPath);
      return;
    }
    const staged = this.stagingPath("read");
    try {
      const copied = await box.exec(
        "sh",
        ["-c", 'if [ -p "$1" ]; then echo "$1 is a FIFO" >&2; exit 1; fi; cat "$1" > "$2"', "sh", source, staged],
        {},
        { timeoutSecs: this.copyTimeoutSecs() },
      );
      if (copied.exitCode !== 0) {
        throw new Error(`LiteBoxSandbox could not read ${source}: ${(copied.stderr || copied.stdout).trim()}`);
      }
      await box.copyOut(staged, hostPath);
    } finally {
      await box.exec("rm", ["-f", staged]).catch(() => undefined);
    }
  }

  private async copyIntoBox(
    box: LiteBoxInstance,
    hostPath: string,
    target: string,
  ): Promise<void> {
    const prepared = await box.exec("mkdir", ["-p", dirname(target)]);
    if (prepared.exitCode !== 0) {
      throw new Error(
        `LiteBoxSandbox could not create ${dirname(target)}: ${prepared.stderr || prepared.stdout}`,
      );
    }
    await box.copyIn(hostPath, target);
  }
}

/**
 * Native output stream → byte stream. Pumps eagerly and keeps draining after
 * the consumer cancels, so BoxLite's `wait()` can settle. `stripLeading`
 * drops chunks until the first one with content left after it.
 */
function nativeReadable(
  source: LiteBoxNativeStream,
  stripLeading?: (text: string) => string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let leading = stripLeading !== undefined;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      void (async () => {
        try {
          for (let chunk = await source.next(); chunk !== null; chunk = await source.next()) {
            const text = leading ? stripLeading!(chunk) : chunk;
            if (text.length === 0) continue;
            leading = false;
            if (!cancelled) controller.enqueue(encoder.encode(text));
          }
        } catch {
          // A reset native stream ends this output; wait() still reports the exit.
        }
        if (!cancelled) controller.close();
      })();
    },
    cancel() {
      cancelled = true;
    },
  });
}

/** true when `promise` settles within `ms`; its rejection propagates. */
async function settlesWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** BoxLite reports a signal death as a negative exit code (-9 → SIGKILL). */
function signalName(signal: number): string {
  const known = Object.entries(osConstants.signals).find(([, value]) => value === signal);
  return known ? known[0] : `SIG${signal}`;
}

async function removeBestEffort(path: string, recursive = false): Promise<void> {
  try {
    await fs.rm(path, { recursive, force: true });
  } catch {
    // Scratch cleanup must never mask the sandbox operation's outcome.
  }
}

/**
 * boxlite-shim (0.9.0) is a static glibc binary that hosts gvproxy (Go).
 * gvproxy answers guest DNS through Go's cgo resolver, so the first lookup
 * from the VM runs the shim's static `getaddrinfo`, which dlopens the host's
 * NSS modules (`hosts: mymachines resolve ...` on systemd hosts) built for a
 * different glibc. The shim dies with SIGSEGV (`exit` file in the box dir:
 * signal 11), the open exec stream fails with "h2 protocol error" and every
 * later call gets "Connection refused". Go's pure resolver keeps NSS out of
 * the shim; the shim inherits this process's environment when BoxLite
 * spawns it. An operator-chosen `netdns` setting is left alone.
 *
 * This is a workaround for how boxlite-shim is built (gvproxy without the
 * netgo tag), not a fix; setting GODEBUG=netdns=go in the server's own
 * environment makes it unnecessary.
 */
export function applyShimDnsWorkaround(
  env: Record<string, string | undefined>,
): boolean {
  const current = env.GODEBUG ?? "";
  if (/(^|,)\s*netdns=/.test(current)) return false;
  env.GODEBUG = current.trim() ? `${current},netdns=go` : "netdns=go";
  return true;
}

const shimDnsWindows = new WeakMap<
  Record<string, string | undefined>,
  { holds: number; previous: string | undefined; applied: string }
>();

/**
 * Runs `boot` (the call that makes BoxLite spawn boxlite-shim) with
 * `applyShimDnsWorkaround` applied to `env`, then puts GODEBUG back, so the
 * setting reaches the shim and not every later child of this process.
 * Overlapping boots share one window: GODEBUG is restored when the last one
 * settles, and only if nothing else changed it meanwhile. `onApplied` runs
 * when the window opens.
 */
export async function withShimDnsWorkaround<T>(
  env: Record<string, string | undefined>,
  boot: () => Promise<T>,
  onApplied: () => void = () => {},
): Promise<T> {
  let window = shimDnsWindows.get(env);
  if (!window) {
    const previous = env.GODEBUG;
    if (!applyShimDnsWorkaround(env)) return boot();
    window = { holds: 0, previous, applied: env.GODEBUG! };
    shimDnsWindows.set(env, window);
    onApplied();
  }
  window.holds += 1;
  try {
    return await boot();
  } finally {
    window.holds -= 1;
    if (window.holds === 0) {
      shimDnsWindows.delete(env);
      if (env.GODEBUG === window.applied) {
        if (window.previous === undefined) delete env.GODEBUG;
        else env.GODEBUG = window.previous;
      }
    }
  }
}

/**
 * Environment networking → BoxLite egress policy. BoxLite 0.9.0 semantics
 * (checked in a VM): `enabled` with an empty or absent `allowNet` is
 * unrestricted; a non-empty `allowNet` lets TCP reach only those hosts;
 * `disabled` removes the network. A limited environment therefore never maps
 * to an empty `allowNet`: with nothing allowed the box gets no network.
 * MCP servers are reached by the host process, not from the VM, so
 * `allowMcpServers` adds no VM egress.
 */
export function liteBoxNetwork(
  networking: SandboxEnvironmentNetworking | undefined,
  extraHosts: readonly string[] = [],
): LiteBoxNetwork {
  const hosts = environmentAllowedHosts(networking);
  if (hosts === null) return { mode: "enabled" };
  if (hosts.size === 0) return { mode: "disabled" };
  for (const entry of extraHosts) {
    const host = normaliseHost(entry);
    if (host) hosts.add(host);
  }
  return { mode: "enabled", allowNet: [...hosts] };
}

/** Hosts a limited environment allows (normalised, package registries
 *  included when allowed); `null` when networking is unrestricted. */
function environmentAllowedHosts(
  networking: SandboxEnvironmentNetworking | undefined,
): Set<string> | null {
  if (!networking || networking.type === "unrestricted") return null;
  const hosts = new Set<string>();
  for (const entry of networking.allowedHosts) {
    const host = normaliseHost(entry);
    if (host) hosts.add(host);
  }
  if (networking.allowPackageManagers) {
    for (const list of Object.values(PACKAGE_MANAGER_HOSTS)) {
      for (const host of list) hosts.add(host);
    }
  }
  return hosts;
}

/**
 * Where a limited environment's allowlist is weaker than it reads (BoxLite
 * 0.9.0): wildcards and the vault proxy host are left to BoxLite's allowlist
 * DNS, which answers zones in random order and may sinkhole them; a client
 * that honours HTTPS_PROXY reaches any host through the vault proxy; and
 * with no allowed host at all the box has no network, the proxy included.
 */
function allowlistWarnings(
  networking: SandboxEnvironmentNetworking | undefined,
  network: LiteBoxNetwork,
): string[] {
  if (!networking || networking.type === "unrestricted") return [];
  if (network.mode === "disabled") {
    return ["limited networking without allowed hosts: the box has no network, the vault proxy included"];
  }
  // A limited environment always has a host set (see environmentAllowedHosts).
  const warnings = [...environmentAllowedHosts(networking)!]
    .filter((host) => host.startsWith("*."))
    .map((host) =>
      `allowed host ${host} is not pinned in /etc/hosts: BoxLite 0.9.0 allowlist DNS may answer 0.0.0.0 for it`);
  for (const proxy of outboundProxyHosts()) {
    const host = normaliseHost(proxy);
    if (!host) continue;
    warnings.push(
      `vault proxy ${host} is allowed but not pinned (BoxLite 0.9.0 allowlist DNS may answer 0.0.0.0); ` +
      "clients that honour HTTPS_PROXY reach any host through it, so the allowlist does not limit them",
    );
  }
  return warnings;
}

function describeNetwork(network: LiteBoxNetwork): string {
  if (network.mode === "disabled") return "disabled";
  return network.allowNet ? `allow ${network.allowNet.length} host(s)` : "unrestricted";
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function egressOf(network: LiteBoxNetwork): SandboxEgress {
  if (network.mode === "disabled") return { type: "none" };
  return network.allowNet ? { type: "allowlist", hosts: [...network.allowNet] } : { type: "unrestricted" };
}

/**
 * The catalog checked the digest of an OCI layout when it loaded; a rebuild
 * or an edit of the directory since then would boot other content under the
 * same key. The layout is read again right before the VM: on a mismatch no
 * VM is created. A registry reference is pinned by digest, BoxLite pulls
 * exactly that.
 */
async function verifyCatalogLayout(image: SandboxEnvironmentImage): Promise<void> {
  if (image.source.type !== "oci") return;
  const onDisk = await readOciIndexDigest(image.source.dir);
  if (onDisk === image.digest) return;
  throw new SandboxEnvironmentError(
    "image_changed_on_disk",
    `sandbox image "${image.key}" changed on disk after the catalog checked it: index.json ` +
    `${onDisk === null ? "has no readable manifest digest" : `points to ${onDisk}`}, the catalog verified ` +
    `${image.digest}. The VM was not created (image_changed_on_disk).`,
  );
}

/** The vault proxy stays reachable when egress is limited to some hosts.
 *  With no allowed host the box has no network at all (see liteBoxNetwork),
 *  the proxy included: allowing only the proxy would open every host to
 *  clients that use it. */
function outboundProxyHosts(): string[] {
  const proxyUrl = process.env.OMA_VAULT_PROXY_URL;
  return proxyUrl ? [proxyUrl] : [];
}

/** `https://user@Example.com:443/path` → `example.com`; `*.example.com` stays. */
function normaliseHost(entry: string): string | null {
  const withoutScheme = entry.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  const authority = withoutScheme.replace(/[/?#].*$/s, "");
  const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/, "");
  return host || null;
}

const ANSI = "(?:\\x1b\\[[0-9;]*m)*";
const RUNTIME_LOG_LINE = new RegExp(
  `^${ANSI}\\d{4}-\\d{2}-\\d{2}T[0-9:.]+Z${ANSI}\\s+${ANSI}\\s*(?:TRACE|DEBUG|INFO|WARN|ERROR)${ANSI}\\s+${ANSI}libcontainer::[^\\n]*(?:\\n|$)`,
);

/**
 * The guest's container runtime (youki libcontainer inside boxlite-guest)
 * logs to the exec'd process's stderr before the command starts: on every
 * exec "WARN libcontainer::process::init::process: seccomp not available,
 * unable to set seccomp privileges!" with ANSI colors. The model and the
 * console would otherwise see it as command output. Only those leading
 * runtime lines are dropped; the command's own stderr is untouched.
 */
export function stripRuntimeNoise(stderr: string): string {
  let rest = stderr;
  for (let match = RUNTIME_LOG_LINE.exec(rest); match; match = RUNTIME_LOG_LINE.exec(rest)) {
    rest = rest.slice(match[0].length);
  }
  return rest;
}

// ── Factory (DIP entry point) ───────────────────────────────────────

export const sandboxFactory: SandboxFactory = async (ctx, env) => {
  return new LiteBoxSandbox({
    image: env.SANDBOX_IMAGE,
    memoryMib: env.LITEBOX_MEMORY_MIB ? Number(env.LITEBOX_MEMORY_MIB) : undefined,
    cpus: env.LITEBOX_CPUS ? Number(env.LITEBOX_CPUS) : undefined,
    diskSizeGb: env.LITEBOX_DISK_SIZE_GB ? Number(env.LITEBOX_DISK_SIZE_GB) : undefined,
    name: `oma-${ctx.sessionId}`,
    memoryRoot: ctx.memoryRoot,
    outputsRoot: ctx.outputsRoot,
    scratchRoot: ctx.workdir,
    environment: ctx.environment,
  });
};
