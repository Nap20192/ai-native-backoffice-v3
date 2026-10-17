// LiteBox VMs from the sandbox image catalog (docs/plans/environments.md,
// 1.6, 1.7 and 4.5) on a fake BoxLite SDK: the OCI layout and resources of
// the catalog image, the digest check before the VM, bash for agent
// commands and the VM snapshot for the "Environment" prompt block.

import { promises as fs, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  instances: [] as FakeBox[],
  options: [] as Array<Record<string, unknown>>,
}));

vi.mock("@boxlite-ai/boxlite", () => ({
  SimpleBox: class {
    constructor(options: Record<string, unknown>) {
      sdk.options.push(options);
      const box = sdk.instances.shift();
      if (!box) throw new Error("fake box missing");
      return box;
    }
  },
}));

import {
  SandboxEnvironmentError,
  supportsEnvironmentSnapshot,
  type SandboxEnvironmentImage,
  type SandboxEnvironmentNetworking,
} from "@open-managed-agents/sandbox";
import { LiteBoxSandbox, sandboxFactory, type LiteBoxSandboxOptions } from "../src/litebox";

type ExecResult = { exitCode: number; stdout: string; stderr: string };
type ExecCall = [string, string[], Record<string, string>?, Record<string, unknown>?];

function fakeBox() {
  return {
    exec: vi.fn(async (..._args: unknown[]): Promise<ExecResult> => ({ exitCode: 0, stdout: "ok\n", stderr: "" })),
    copyIn: vi.fn(async () => {}),
    copyOut: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
}

type FakeBox = ReturnType<typeof fakeBox>;

function queueBox() {
  const box = fakeBox();
  sdk.instances.push(box);
  return box;
}

function calls(box: FakeBox): ExecCall[] {
  return box.exec.mock.calls as unknown as ExecCall[];
}

const DIGEST = `sha256:${"3f".repeat(32)}`;
const OTHER_DIGEST = `sha256:${"0d".repeat(32)}`;
const MANIFEST_SHA = `sha256:${"ab".repeat(32)}`;
/** image-manifest.json of the image, trimmed. */
const MANIFEST = { image_digest: DIGEST, os: { name: "Debian GNU/Linux", version: "12 (bookworm)" }, shell: "/bin/bash", pip: [{ name: "python-pptx", version: "1.0.2" }] };
const layouts: string[] = [];

async function ociLayout(digest: string | null = DIGEST): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), "openma-litebox-oci-"));
  layouts.push(dir);
  if (digest !== null) {
    await fs.writeFile(join(dir, "index.json"), JSON.stringify({ schemaVersion: 2, manifests: [{ digest }] }));
  }
  return dir;
}

function catalogImage(dir: string, overrides: Partial<SandboxEnvironmentImage> = {}): SandboxEnvironmentImage {
  return {
    key: "workplace",
    source: { type: "oci", dir },
    digest: DIGEST,
    manifestSha256: MANIFEST_SHA,
    manifest: structuredClone(MANIFEST),
    resources: { diskGb: 6, memoryMib: 1024, cpus: 2 },
    shell: "bash",
    ...overrides,
  };
}

const quiet = () => ({ warn: vi.fn(), log: vi.fn() });
const originalProxy = process.env.OMA_VAULT_PROXY_URL;
const sandboxes: LiteBoxSandbox[] = [];

/** A sandbox whose scratch directory and VM go away after the test, even a failed one. */
function sandboxOf(options: LiteBoxSandboxOptions): LiteBoxSandbox {
  const scratchRoot = mkdtempSync(join(tmpdir(), "openma-litebox-scratch-"));
  layouts.push(scratchRoot);
  const sandbox = new LiteBoxSandbox({ scratchRoot, ...options });
  sandboxes.push(sandbox);
  return sandbox;
}

beforeEach(() => {
  sdk.instances.length = 0;
  sdk.options.length = 0;
  delete process.env.OMA_VAULT_PROXY_URL;
});

afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.destroy();
  if (originalProxy === undefined) delete process.env.OMA_VAULT_PROXY_URL;
  else process.env.OMA_VAULT_PROXY_URL = originalProxy;
  for (const dir of layouts.splice(0)) await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("LiteBoxSandbox with a catalog image", () => {
  it("boots the VM from the OCI layout with the catalog resources instead of the server image", async () => {
    const dir = await ociLayout();
    queueBox();
    const logger = quiet();
    const sandbox = sandboxOf({
      image: "server:1", memoryMib: 512, cpus: 1, diskSizeGb: 4, name: "oma-s", logger,
      environment: { image: catalogImage(dir) },
    });
    await expect(sandbox.exec("echo hi")).resolves.toBe("ok");
    expect(sdk.options).toEqual([{
      rootfsPath: dir, memoryMib: 1024, cpus: 2, diskSizeGb: 6, name: "oma-s", volumes: [], network: { mode: "enabled" },
    }]);
    expect(sdk.options[0]).not.toHaveProperty("image");
    expect(logger.log).toHaveBeenCalledWith(`creating box (image=workplace ${DIGEST}, network=unrestricted)`);
    await sandbox.destroy();
  });

  it("keeps the server resources the catalog leaves out", async () => {
    const dir = await ociLayout();
    queueBox();
    const sandbox = sandboxOf({
      memoryMib: 512, cpus: 1, diskSizeGb: 4, logger: quiet(),
      environment: { image: catalogImage(dir, { resources: { diskGb: 6, memoryMib: null, cpus: null } }) },
    });
    await sandbox.exec("true");
    expect(sdk.options[0]).toMatchObject({ rootfsPath: dir, memoryMib: 512, cpus: 1, diskSizeGb: 6 });
    await sandbox.destroy();
  });

  it("boots a registry image of the catalog by its pinned reference", async () => {
    const reference = `docker.io/library/node:22-bookworm@${DIGEST}`;
    queueBox();
    const logger = quiet();
    const sandbox = sandboxOf({
      image: "server:1", logger,
      environment: {
        image: catalogImage("/unused", { key: "legacy", source: { type: "registry", reference }, resources: { diskGb: 4, memoryMib: 512, cpus: 1 } }),
      },
    });
    await sandbox.exec("true");
    expect(sdk.options[0]).toMatchObject({ image: reference, memoryMib: 512, cpus: 1, diskSizeGb: 4 });
    expect(sdk.options[0]).not.toHaveProperty("rootfsPath");
    expect(logger.log).toHaveBeenCalledWith(`creating box (image=legacy ${DIGEST}, network=unrestricted)`);
    await sandbox.destroy();
  });

  it("does not create a VM when the OCI layout changed on disk after the catalog checked it", async () => {
    for (const onDisk of [OTHER_DIGEST, null]) {
      const dir = await ociLayout(onDisk);
      const sandbox = sandboxOf({ logger: quiet(), environment: { image: catalogImage(dir) } });
      const failure = sandbox.exec("true");
      await expect(failure).rejects.toBeInstanceOf(SandboxEnvironmentError);
      await expect(failure).rejects.toMatchObject({ code: "image_changed_on_disk" });
      await expect(failure).rejects.toThrow(/sandbox image "workplace"/);
      await expect(failure).rejects.toThrow(DIGEST);
      if (onDisk !== null) await expect(failure).rejects.toThrow(onDisk);
      // The same error on every later call, and never a VM.
      await expect(sandbox.exec("true")).rejects.toMatchObject({ code: "image_changed_on_disk" });
      expect(sdk.options).toEqual([]);
      await sandbox.destroy();
    }
  });
});

describe("shell of agent commands", () => {
  it("runs agent commands through bash on an image with bash, install scripts stay POSIX sh", async () => {
    const dir = await ociLayout();
    const box = queueBox();
    const sandbox = sandboxOf({
      logger: quiet(),
      environment: { image: catalogImage(dir), packages: { pip: ["tomli-w==1.2.0"] } },
    });
    await sandbox.exec("[[ -d /workspace ]] && echo ok");
    await sandbox.exec("set -o pipefail; true | true");
    expect(calls(box).map(([command]) => command)).toEqual(["mkdir", "sh", "bash", "bash"]);
    expect(calls(box)[1]?.[1][1]).toContain("uv pip install --python \"$py\"");
    expect(calls(box)[2]?.[1]).toEqual(["-c", "[[ -d /workspace ]] && echo ok"]);
    expect(calls(box)[2]?.[3]).toEqual({ cwd: "/workspace", timeoutSecs: 120 });
    await sandbox.destroy();
  });

  it("looks for bash once in the VM when the catalog does not know the shell", async () => {
    for (const [found, shell] of [[0, "bash"], [1, "sh"]] as const) {
      const dir = await ociLayout();
      const box = queueBox();
      box.exec
        .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ exitCode: found, stdout: "", stderr: "" });
      const sandbox = sandboxOf({ logger: quiet(), environment: { image: catalogImage(dir, { shell: null }) } });
      expect(sandbox.environmentSnapshot().shell).toBeNull();
      await sandbox.exec("one");
      await sandbox.exec("two");
      expect(calls(box).map(([command, args]) => [command, args])).toEqual([
        ["mkdir", ["-p", "/workspace"]],
        ["sh", ["-c", "command -v bash >/dev/null 2>&1"]],
        [shell, ["-c", "one"]],
        [shell, ["-c", "two"]],
      ]);
      expect(sandbox.environmentSnapshot().shell).toBe(shell);
      await sandbox.destroy();
    }
  });

  it("keeps sh and the server image without a catalog image", async () => {
    const box = queueBox();
    const sandbox = sandboxOf({ logger: quiet() });
    await sandbox.exec("x");
    expect(calls(box).map(([command]) => command)).toEqual(["mkdir", "sh"]);
    expect(sdk.options[0]).toMatchObject({ image: "node:22-bookworm" });
    expect(sandbox.environmentSnapshot().shell).toBe("sh");
    await sandbox.destroy();
  });
});

describe("environment snapshot of the VM", () => {
  it("states what the VM is created with before it exists, without creating it", async () => {
    const dir = await ociLayout();
    const sandbox = sandboxOf({
      logger: quiet(),
      resolveHost: async () => ["198.51.100.1"],
      environment: {
        image: catalogImage(dir),
        packages: { pip: [" duckdb ", "pyarrow"], apt: [], npm: ["cowsay@1.6.0"] },
        networking: { type: "limited", allowedHosts: ["Example.org"], allowPackageManagers: false, allowMcpServers: true },
      },
    });
    expect(supportsEnvironmentSnapshot(sandbox)).toBe(true);
    expect(supportsEnvironmentSnapshot({ exec: async () => "" })).toBe(false);
    expect(sandbox.environmentSnapshot()).toEqual({
      image: { key: "workplace", reference: null, digest: DIGEST, manifestSha256: MANIFEST_SHA, manifest: MANIFEST },
      shell: "bash",
      workingDirectory: "/workspace",
      networking: { type: "limited", allowedHosts: ["Example.org"], allowPackageManagers: false, allowMcpServers: true },
      egress: { type: "allowlist", hosts: ["example.org"] },
      packages: { pip: ["duckdb", "pyarrow"], npm: ["cowsay@1.6.0"] },
      resources: { diskGb: 6, memoryMib: 1024, cpus: 2 },
      vm: null,
    });
    expect(sdk.options).toEqual([]);
    await sandbox.destroy();
  });

  it("adds when the VM became ready, and forgets the VM once it is destroyed", async () => {
    const dir = await ociLayout();
    queueBox();
    const logger = quiet();
    const sandbox = sandboxOf({ logger, environment: { image: catalogImage(dir), packages: { pip: ["duckdb"] } } });
    const before = Date.now();
    await sandbox.exec("true");
    const { vm } = sandbox.environmentSnapshot();
    expect(vm).not.toBeNull();
    expect(Date.parse(vm!.readyAt)).toBeGreaterThanOrEqual(before - 1);
    expect(vm!.readyMs).toBeGreaterThanOrEqual(0);
    expect(logger.log).toHaveBeenCalledWith(`box ready in ${vm!.readyMs} ms`);
    await sandbox.destroy();
    expect(sandbox.environmentSnapshot().vm).toBeNull();
  });

  it("describes the egress the adapter applies, the vault proxy included", async () => {
    process.env.OMA_VAULT_PROXY_URL = "http://vault.internal:8790";
    const limited = (allowedHosts: string[]): SandboxEnvironmentNetworking =>
      ({ type: "limited", allowedHosts, allowPackageManagers: false, allowMcpServers: false });
    const snapshot = (networking?: SandboxEnvironmentNetworking) =>
      sandboxOf({ logger: quiet(), ...(networking && { environment: { networking } }) }).environmentSnapshot();
    expect(snapshot().egress).toEqual({ type: "unrestricted" });
    expect(snapshot().networking).toEqual({ type: "unrestricted" });
    expect(snapshot({ type: "unrestricted" }).egress).toEqual({ type: "unrestricted" });
    expect(snapshot(limited([])).egress).toEqual({ type: "none" });
    expect(snapshot(limited(["api.example.com"])).egress).toEqual({ type: "allowlist", hosts: ["api.example.com", "vault.internal"] });
  });

  it("describes the server image without catalog facts", async () => {
    const sandbox = sandboxOf({ image: "img:1", memoryMib: 768, logger: quiet() });
    expect(sandbox.environmentSnapshot()).toMatchObject({
      image: { key: null, reference: "img:1", digest: null, manifestSha256: null, manifest: null },
      shell: "sh",
      packages: {},
      resources: { diskGb: null, memoryMib: 768, cpus: null },
      vm: null,
    });
    const defaults = sandboxOf({ logger: quiet() });
    expect(defaults.environmentSnapshot().image.reference).toBe("node:22-bookworm");
    await sandbox.destroy();
    await defaults.destroy();
  });

  it("hands out copies the caller cannot change", async () => {
    const dir = await ociLayout();
    const image = catalogImage(dir);
    const sandbox = sandboxOf({
      logger: quiet(),
      environment: { image, packages: { pip: ["duckdb"] } },
    });
    const first = sandbox.environmentSnapshot();
    first.packages.pip!.push("evil");
    first.image.key = "other";
    first.resources.cpus = 64;
    // The manifest is shared between snapshots, so it cannot be changed at all.
    expect(() => { (first.image.manifest as Record<string, unknown>).shell = "/bin/evil"; }).toThrow(TypeError);
    expect(() => { ((first.image.manifest as typeof MANIFEST).pip[0] as { name: string }).name = "evil"; }).toThrow(TypeError);
    // Nor does the host's object change the VM's: the adapter keeps its own copy.
    (image.manifest as Record<string, unknown>).shell = "/bin/host-edit";
    expect(sandbox.environmentSnapshot()).toMatchObject({
      image: { key: "workplace", manifest: MANIFEST }, packages: { pip: ["duckdb"] }, resources: { cpus: 2 },
    });
    await sandbox.destroy();
  });
});

describe("factory with a catalog image", () => {
  it("lets the catalog image and its resources win over the server settings", async () => {
    const dir = await ociLayout();
    queueBox();
    const sandbox = await sandboxFactory(
      { sessionId: "s1", workdir: dir, environment: { image: catalogImage(dir) } },
      { SANDBOX_IMAGE: "server:1", LITEBOX_MEMORY_MIB: "512", LITEBOX_CPUS: "1", LITEBOX_DISK_SIZE_GB: "4" },
    );
    await sandbox.exec("true");
    expect(sdk.options[0]).toMatchObject({ rootfsPath: dir, memoryMib: 1024, cpus: 2, diskSizeGb: 6, name: "oma-s1" });
    await sandbox.destroy?.();
  });
});
