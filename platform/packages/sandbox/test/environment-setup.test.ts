import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEnvironmentSetupScript,
  environmentPackageLists,
  environmentSetupFailure,
  isSandboxEnvironmentError,
  PACKAGE_MANAGER_HOSTS,
  SandboxEnvironmentError,
  type SandboxEnvironmentPackages,
} from "../src/index";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Runs the generated script with PATH limited to stub binaries that record
 * their argv; `exits` makes a stub fail when its argv contains the key. */
function run(packages: SandboxEnvironmentPackages, stubs: string[], exits: Record<string, number> = {}) {
  const bin = mkdtempSync(join(tmpdir(), "oma-setup-stubs-"));
  dirs.push(bin);
  const log = join(bin, "calls.log");
  writeFileSync(log, "");
  for (const name of stubs) {
    const failures = Object.entries(exits)
      .filter(([key]) => key.startsWith(`${name} `))
      .map(([key, code]) => `case "$*" in *"${key.slice(name.length + 1)}"*) exit ${code};; esac`)
      .join("\n");
    const path = join(bin, name);
    writeFileSync(
      path,
      `#!/bin/sh\nprintf '%s' "${name}" >> '${log}'\nfor a in "$@"; do printf ' [%s]' "$a" >> '${log}'; done\necho >> '${log}'\n${failures}\nexit 0\n`,
    );
    chmodSync(path, 0o755);
  }
  const script = buildEnvironmentSetupScript(packages);
  if (script === null) throw new Error("expected a script");
  const result = spawnSync("/bin/sh", ["-c", script], { env: { PATH: bin }, encoding: "utf8" });
  return {
    bin,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
  };
}

describe("buildEnvironmentSetupScript", () => {
  it("returns null when nothing is configured", () => {
    expect(buildEnvironmentSetupScript(undefined)).toBeNull();
    expect(buildEnvironmentSetupScript({})).toBeNull();
    expect(buildEnvironmentSetupScript({ apt: [], npm: ["  ", ""] })).toBeNull();
    expect(environmentPackageLists({ npm: [" a "], apt: ["b"] })).toEqual([
      { manager: "apt", names: ["b"] },
      { manager: "npm", names: ["a"] },
    ]);
  });

  it("installs apt then npm packages system-wide with every name passed literally", () => {
    const tricky = "it's $(touch pwned) `x`";
    const r = run({ npm: ["left-pad"], apt: ["jq", tricky] }, ["apt-get", "npm"]);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      "apt-get [update] [-qq]",
      `apt-get [install] [-y] [-qq] [--no-install-recommends] [jq] [${tricky}]`,
      "npm [install] [-g] [--no-fund] [--no-audit] [--loglevel=error] [left-pad]",
    ]);
    expect(r.stdout).toContain("[oma-setup] apt: 2 package(s)");
    expect(r.stdout.trimEnd().endsWith("[oma-setup] done")).toBe(true);
  });

  it("stops at the first failing manager with its exit code", () => {
    const r = run({ apt: ["nope"], npm: ["left-pad"] }, ["apt-get", "npm"], { "apt-get install": 100 });
    expect(r.status).toBe(100);
    expect(r.stderr).toContain("[oma-setup] apt failed (exit 100)");
    expect(r.calls.some((call) => call.startsWith("npm"))).toBe(false);
    expect(r.stdout).not.toContain("[oma-setup] done");
  });

  it("does not install when the apt index update fails", () => {
    const r = run({ apt: ["jq"] }, ["apt-get"], { "apt-get update": 100 });
    expect(r.status).toBe(100);
    expect(r.calls).toEqual(["apt-get [update] [-qq]"]);
  });

  it("names a missing toolchain instead of failing with command not found", () => {
    const r = run({ npm: ["left-pad"] }, []);
    expect(r.status).toBe(127);
    expect(r.stderr).toContain("[oma-setup] npm not found in the sandbox image");
    expect(r.stderr).toContain("[oma-setup] npm failed (exit 127)");
  });

  it("falls back to apk on Alpine images and to uv or pip for Python", () => {
    expect(run({ apt: ["jq"] }, ["apk"]).calls).toEqual(["apk [add] [--no-cache] [jq]"]);
    const uv = run({ pip: ["requests"] }, ["uv", "python3"]);
    expect(uv.calls).toEqual([
      `uv [pip] [install] [--python] [${join(uv.bin, "python3")}] [--break-system-packages] [requests]`,
    ]);
    expect(run({ pip: ["requests"] }, ["python3"]).calls).toEqual([
      "python3 [-m] [pip] [--version]",
      "python3 [-m] [pip] [install] [--no-cache-dir] [--disable-pip-version-check] [-q] [requests]",
    ]);
    expect(run({ pip: ["requests"] }, []).stderr).toContain("python3 with pip (or uv) not found");
  });

  it("installs pip packages into the python3 first on PATH, the venv of a catalog image", () => {
    // Catalog images put /usr/local/bin/python3 (their /opt/venv) first on
    // PATH. `uv pip install --system` would skip that venv for the system
    // Python, so both installers get the python3 that PATH resolves.
    const viaUv = run({ pip: ["python-pptx>=1.0"] }, ["uv", "python3"]);
    expect(viaUv.status).toBe(0);
    expect(viaUv.calls[0]).toContain(`[--python] [${join(viaUv.bin, "python3")}]`);
    expect(viaUv.calls[0]).not.toContain("[--system]");
    const viaPip = run({ pip: ["python-pptx>=1.0"] }, ["python3"]);
    expect(viaPip.status).toBe(0);
    expect(viaPip.calls.at(-1)).toBe(
      "python3 [-m] [pip] [install] [--no-cache-dir] [--disable-pip-version-check] [-q] [python-pptx>=1.0]",
    );
    // uv alone has no Python to install into.
    const uvOnly = run({ pip: ["requests"] }, ["uv"]);
    expect(uvOnly.status).toBe(127);
    expect(uvOnly.calls).toEqual([]);
    expect(uvOnly.stderr).toContain("python3 with pip (or uv) not found");
  });

  it("installs cargo, go and gem packages and stops a go loop at the first failure", () => {
    const ok = run({ cargo: ["ripgrep"], go: ["a@latest"], gem: ["rake"] }, ["cargo", "go", "gem"]);
    expect(ok.status).toBe(0);
    expect(ok.calls).toEqual([
      "cargo [install] [--quiet] [--root] [/usr/local] [ripgrep]",
      "go [install] [a@latest]",
      "gem [install] [--no-document] [rake]",
    ]);
    const failed = run({ go: ["bad@latest", "b@latest"] }, ["go"], { "go install bad": 1 });
    expect(failed.status).toBe(1);
    expect(failed.calls).toEqual(["go [install] [bad@latest]"]);
  });
});

describe("environmentSetupFailure", () => {
  it("names the manager and the exit code of the section that failed", () => {
    const r = run({ apt: ["jq"], pip: ["nope-pkg"] }, ["apt-get", "python3"], { "python3 install": 1 });
    expect(r.status).toBe(1);
    const failure = environmentSetupFailure(`${r.stdout}\n${r.stderr}`, r.status);
    expect(failure).toMatchObject({ manager: "pip", exitCode: 1 });
    expect(failure.outputTail).toContain("[oma-setup] pip failed (exit 1)");
  });

  it("names the manager that was running when the script stopped without a failure line", () => {
    const output = "[oma-setup] apt: 1 package(s)\n[oma-setup] npm: 2 package(s)\nnpm http fetch GET 200";
    expect(environmentSetupFailure(output, null)).toEqual({ manager: "npm", exitCode: null, outputTail: output });
    expect(environmentSetupFailure("killed", 137)).toEqual({ manager: null, exitCode: 137, outputTail: "killed" });
  });

  it("keeps only the end of a long output", () => {
    const output = `${"x".repeat(2_000)}\n[oma-setup] gem failed (exit 2)`;
    const failure = environmentSetupFailure(output, 2);
    expect(failure.manager).toBe("gem");
    expect(failure.outputTail.length).toBe(600);
    expect(failure.outputTail.endsWith("[oma-setup] gem failed (exit 2)")).toBe(true);
  });
});

describe("SandboxEnvironmentError", () => {
  it("carries the failed install for packages_failed and nothing for the image codes", () => {
    const packages = { manager: "pip" as const, exitCode: 1, outputTail: "ERROR: No matching distribution" };
    const failed = new SandboxEnvironmentError("packages_failed", "environment packages failed", packages);
    expect(failed.packages).toEqual(packages);
    expect(isSandboxEnvironmentError(failed)).toBe(true);
    const image = new SandboxEnvironmentError("image_unavailable", "Образ песочницы «x» не найден");
    expect(image.packages).toBeNull();
    expect(isSandboxEnvironmentError(new Error("other"))).toBe(false);
  });
});

describe("PACKAGE_MANAGER_HOSTS", () => {
  it("lists registry hosts for every package manager", () => {
    for (const manager of ["apt", "cargo", "gem", "go", "npm", "pip"] as const) {
      expect(PACKAGE_MANAGER_HOSTS[manager].length).toBeGreaterThan(0);
    }
    expect(PACKAGE_MANAGER_HOSTS.apt).toContain("deb.debian.org");
    expect(PACKAGE_MANAGER_HOSTS.npm).toContain("registry.npmjs.org");
  });
});
