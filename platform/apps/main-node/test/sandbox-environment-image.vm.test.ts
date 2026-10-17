// One real BoxLite VM from the `workplace` image of the sandbox catalog
// (docs/plans/environments.md, ES2). The path is the one a session takes:
// platform/sandbox-images/catalog.json, the OCI layout in SANDBOX_IMAGE_DIR,
// createSandboxImageSpec, then the LiteBox adapter.
//
// Opt-in, it boots a VM and installs packages from PyPI:
//   OMA_LITEBOX_VM_TEST=1 nice -n 15 test-slot ./node_modules/.bin/vitest run \
//     --config vitest.config.ts --pool=forks test/sandbox-environment-image.vm.test.ts
//
// Needs /dev/kvm, the image built by platform/sandbox-images/build.sh
// (SANDBOX_IMAGE_DIR, default ~/.cache/ai-backoffice-v3/environments/sandbox-images)
// and access to PyPI. BoxLite gets its own runtime home and the session its
// scratch directory under ~/.cache/ai-backoffice-v3/environments/bx; the test
// removes both, the VM disk included. What the VM answered goes to
// ~/.cache/ai-backoffice-v3/environments/measurements/<run>/es2-vm.json.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { LiteBoxSandbox } from "@open-managed-agents/sandbox-adapter-litebox";

import { createSandboxImageSpec } from "../src/lib/sandbox-environment-image";

const enabled = process.env.OMA_LITEBOX_VM_TEST === "1";
const cache = join(homedir(), ".cache/ai-backoffice-v3/environments");
const imageDir = process.env.SANDBOX_IMAGE_DIR ?? join(cache, "sandbox-images");
const catalogPath = fileURLToPath(new URL("../../../sandbox-images/catalog.json", import.meta.url));
// BoxLite binds <home>/boxes/<id>/sockets/ready.sock: the home path stays short.
const runId = `es2${process.pid.toString(36)}`;
const runDir = join(cache, "bx", runId);

interface BoxliteRuntime { shutdown(timeout?: number): Promise<void> }
interface BoxliteModule {
  JsBoxlite: { initDefault(options: { homeDir: string }): void; withDefaultConfig(): BoxliteRuntime };
}

describe.skipIf(!enabled)("a real LiteBox VM from the workplace catalog image", () => {
  let boxlite: BoxliteModule | undefined;
  let sandbox: LiteBoxSandbox | undefined;

  beforeAll(async () => {
    if (!existsSync("/dev/kvm")) throw new Error("/dev/kvm is unavailable");
    const require = createRequire(new URL("../../../packages/sandbox-adapter-litebox/package.json", import.meta.url));
    boxlite = await import(pathToFileURL(require.resolve("@boxlite-ai/boxlite")).href) as BoxliteModule;
    mkdirSync(join(runDir, "h"), { recursive: true });
    boxlite.JsBoxlite.initDefault({ homeDir: join(runDir, "h") });
  });

  afterAll(async () => {
    await sandbox?.destroy();
    await boxlite?.JsBoxlite.withDefaultConfig().shutdown(10).catch(() => {});
    rmSync(runDir, { recursive: true, force: true });
    expect(existsSync(runDir)).toBe(false);
  });

  it("boots with the catalog resources, imports pptx, installs pip packages into /opt/venv and runs bash", async () => {
    const { image } = await createSandboxImageSpec({ SANDBOX_IMAGE_CATALOG: catalogPath, SANDBOX_IMAGE_DIR: imageDir })("workplace");
    expect(image?.source.type).toBe("oci");
    const lines: string[] = [];
    sandbox = new LiteBoxSandbox({
      name: `es2-vm-${process.pid}`,
      scratchRoot: join(runDir, "w"),
      logger: { log: (message) => lines.push(message), warn: (message) => lines.push(`warn: ${message}`) },
      environment: {
        image,
        // The "Базовое" template: registries open, other hosts closed.
        networking: { type: "limited", allowedHosts: [], allowPackageManagers: true, allowMcpServers: true },
        packages: { pip: ["tomli-w==1.2.0"] },
      },
    });
    const before = sandbox.environmentSnapshot();
    expect(before.vm).toBeNull();

    const shell = await sandbox.exec('[[ -n "$BASH_VERSION" ]] && echo "bash $BASH_VERSION"; pwd', 60_000);
    const pptx = await sandbox.exec(
      `python3 -c "import pptx, sys; from pptx import Presentation; Presentation().save('/workspace/deck.pptx'); print('pptx', pptx.__version__, sys.prefix)"`,
      120_000,
    );
    const environmentPackage = await sandbox.exec(`python3 -c "import tomli_w; print(tomli_w.__file__)"`, 60_000);
    const agentInstall = await sandbox.exec(
      `pip install --no-cache-dir --disable-pip-version-check -q cowsay==6.1 && python3 -c "import cowsay; print(cowsay.__file__)"`,
      300_000,
    );
    const resources = await sandbox.exec(
      "nproc; awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo; df -B1G --output=size / | tail -1",
      60_000,
    );
    const snapshot = sandbox.environmentSnapshot();
    const report = join(cache, "measurements", runId);
    mkdirSync(report, { recursive: true });
    writeFileSync(join(report, "es2-vm.json"), `${JSON.stringify({
      shell, pptx, environmentPackage, agentInstall, resources, log: lines,
      // The manifest lists every package of the image; its digest is enough here.
      snapshot: { ...snapshot, image: { ...snapshot.image, manifest: `image_digest ${String(snapshot.image.manifest?.image_digest)}` } },
    }, null, 2)}\n`);

    expect(shell).toMatch(/^bash 5\.\d/);
    expect(shell).toContain("/workspace");
    expect(pptx).toMatch(/^pptx 1\.0\.2 \/opt\/venv$/);
    expect(environmentPackage).toMatch(/^\/opt\/venv\/lib\/python3\.11\/site-packages\/tomli_w\//);
    expect(agentInstall).toMatch(/^\/opt\/venv\/lib\/python3\.11\/site-packages\/cowsay\//);
    const [cpus, memoryMib, diskGb] = resources.split("\n").map((value) => Number(value.trim()));
    expect(cpus).toBe(2);
    expect(memoryMib).toBeGreaterThan(800);
    expect(memoryMib).toBeLessThanOrEqual(1024);
    expect(diskGb).toBeGreaterThanOrEqual(5);
    expect(diskGb).toBeLessThanOrEqual(6);

    expect(snapshot).toMatchObject({
      image: { key: "workplace", reference: null, digest: image!.digest, manifestSha256: image!.manifestSha256 },
      shell: "bash",
      workingDirectory: "/workspace",
      networking: { type: "limited", allowPackageManagers: true },
      packages: { pip: ["tomli-w==1.2.0"] },
      resources: { diskGb: 6, memoryMib: 1024, cpus: 2 },
    });
    expect(snapshot.egress).toMatchObject({ type: "allowlist", hosts: expect.arrayContaining(["pypi.org", "files.pythonhosted.org"]) });
    expect(snapshot.vm?.readyMs).toBeGreaterThan(0);
    // The block reads the image manifest from the snapshot: the one of its digest.
    expect(snapshot.image.manifest).toMatchObject({ image_digest: snapshot.image.digest, venv: "/opt/venv", user: "root" });
    expect(lines).toContainEqual(`creating box (image=workplace ${image!.digest}, network=allow ${snapshot.egress.type === "allowlist" ? snapshot.egress.hosts.length : 0} host(s))`);
    expect(lines).toContainEqual(`box ready in ${snapshot.vm!.readyMs} ms`);
  }, 900_000);
});
