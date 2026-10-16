// Environment configuration policy (docs/plans/environments.md, ES1): the
// application asks it about `config` on create and update; a rejection names
// the field and becomes a 400 answer.

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEnvironmentConfigPolicy,
  packageBaseName,
  parseSandboxPackagePolicy,
  readSandboxPackagePolicy,
  type PackageNameCheck,
} from "../src/lib/environment-config-policy";
import type { SandboxCatalog, SandboxCatalogImage } from "../src/lib/sandbox-catalog";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function catalogImage(key: string, built = true): SandboxCatalogImage {
  return {
    key,
    label: key,
    source: { type: "oci", dir: `/images/${key}` },
    built,
    reason: built ? null : "Каталог образа не найден",
    digest: built ? `sha256:${"a".repeat(64)}` : null,
    sizeBytes: null,
    resources: { diskGb: null, memoryMib: null, cpus: null },
    manifest: null,
    manifestSha256: null,
  };
}

const enabledCatalog: SandboxCatalog = {
  enabled: true,
  defaultImage: "legacy",
  images: [catalogImage("legacy"), catalogImage("workplace"), catalogImage("workplace-office", false)],
  templates: [],
};

const fallbackCatalog: SandboxCatalog = {
  enabled: false,
  defaultImage: "default",
  images: [
    { ...catalogImage("default"), source: { type: "server_default", reference: null }, digest: null },
  ],
  templates: [],
};

const limited = { type: "limited" as const, allowPackageManagers: true, allowWebSearch: true };

describe("createEnvironmentConfigPolicy: image key", () => {
  const policy = createEnvironmentConfigPolicy({ catalog: enabledCatalog });

  it("accepts no config, a self-hosted config, a null image and known keys", () => {
    expect(policy.checkConfig(null)).toEqual({ type: "accepted" });
    expect(policy.checkConfig({ type: "self_hosted" })).toEqual({ type: "accepted" });
    expect(policy.checkConfig({ type: "cloud" })).toEqual({ type: "accepted" });
    expect(policy.checkConfig({ type: "cloud", image: null, networking: limited })).toEqual({
      type: "accepted",
    });
    expect(policy.checkConfig({ type: "cloud", image: "workplace" })).toEqual({ type: "accepted" });
    // A known image that is not built yet is accepted: sessions name it in their error.
    expect(policy.checkConfig({ type: "cloud", image: "workplace-office" })).toEqual({
      type: "accepted",
    });
  });

  it("rejects an unknown key with the field name", () => {
    expect(policy.checkConfig({ type: "cloud", image: "workplace-gpu" })).toEqual({
      type: "rejected",
      field: "config.image",
      message: 'unknown sandbox image "workplace-gpu"; known images: legacy, workplace, workplace-office',
    });
  });

  it("knows only the default image when no catalog is configured", () => {
    const fallback = createEnvironmentConfigPolicy({ catalog: fallbackCatalog });
    expect(fallback.checkConfig({ type: "cloud", image: "default" })).toEqual({ type: "accepted" });
    expect(fallback.checkConfig({ type: "cloud", image: "workplace" })).toMatchObject({
      type: "rejected",
      field: "config.image",
    });
  });

  it("reads the catalog through a getter on every check", () => {
    let current = fallbackCatalog;
    const live = createEnvironmentConfigPolicy({ catalog: () => current });
    expect(live.checkConfig({ type: "cloud", image: "workplace" }).type).toBe("rejected");
    current = enabledCatalog;
    expect(live.checkConfig({ type: "cloud", image: "workplace" }).type).toBe("accepted");
  });
});

describe("createEnvironmentConfigPolicy: packages", () => {
  const strictNames: PackageNameCheck = (manager, spec) =>
    spec.startsWith("-") || spec.includes("://") ? `"${spec}" is not a ${manager} package name` : null;

  it("rejects cargo, go and gem while the catalog is enabled", () => {
    const policy = createEnvironmentConfigPolicy({ catalog: enabledCatalog });
    for (const manager of ["cargo", "go", "gem"] as const) {
      expect(
        policy.checkConfig({ type: "cloud", packages: { [manager]: ["something"] } }),
      ).toEqual({
        type: "rejected",
        field: `config.packages.${manager}`,
        message: `${manager} packages are not available in catalog images`,
      });
    }
    expect(
      policy.checkConfig({ type: "cloud", packages: { cargo: [], go: null, gem: [] } }),
    ).toEqual({ type: "accepted" });
  });

  it("keeps cargo, go and gem without a catalog", () => {
    const policy = createEnvironmentConfigPolicy({ catalog: fallbackCatalog });
    expect(
      policy.checkConfig({ type: "cloud", packages: { cargo: ["ripgrep"], go: ["x"], gem: ["rake"] } }),
    ).toEqual({ type: "accepted" });
  });

  it("asks the name check about every package and names the failing item", () => {
    const seen: string[] = [];
    const policy = createEnvironmentConfigPolicy({
      catalog: enabledCatalog,
      checkPackageName: (manager, spec) => {
        seen.push(`${manager}:${spec}`);
        return strictNames(manager, spec);
      },
    });

    expect(
      policy.checkConfig({
        type: "cloud",
        packages: { apt: ["figlet"], pip: ["numpy==2.0.2", "--index-url=https://x"], npm: ["cowsay"] },
      }),
    ).toEqual({
      type: "rejected",
      field: "config.packages.pip.1",
      message: '"--index-url=https://x" is not a pip package name',
    });
    expect(seen).toEqual(["apt:figlet", "pip:numpy==2.0.2", "pip:--index-url=https://x"]);
  });

  it("checks pip, npm and apt names against the 3.2 whitelist by default", () => {
    const policy = createEnvironmentConfigPolicy({ catalog: enabledCatalog });
    for (const [manager, spec] of [
      ["pip", "--index-url=https://x"], ["pip", "name @ https://x/p.whl"], ["pip", "pkg==1.0+local"],
      ["npm", "pkg@latest"], ["npm", "github:user/repo"], ["apt", "pkg=1.0"], ["apt", "./x.deb"],
    ] as const) {
      const result = policy.checkConfig({ type: "cloud", packages: { [manager]: ["ok-name", spec] } });
      expect(result).toMatchObject({ type: "rejected", field: `config.packages.${manager}.1` });
      // The value can hold a token, so the message does not repeat it.
      expect(result.type === "rejected" && result.message).not.toContain(spec);
    }
    expect(
      policy.checkConfig({ type: "cloud", packages: { pip: ["pandas[excel]>=2.2,<3"], npm: ["@scope/pkg@1.2.3"], apt: ["python3-bs4"] } }),
    ).toEqual({ type: "accepted" });
  });

  it("applies the operator deny list by package name, ignoring versions and case", () => {
    const policy = createEnvironmentConfigPolicy({
      catalog: enabledCatalog,
      packagePolicy: parseSandboxPackagePolicy({ deny: { pip: ["Python_Dotenv"], npm: ["@evil/pkg"] } }),
    });

    expect(policy.checkConfig({ type: "cloud", packages: { pip: ["python-dotenv[cli]>=1.0"] } })).toEqual({
      type: "rejected",
      field: "config.packages.pip.0",
      message: 'pip package "python-dotenv" is blocked by the operator policy',
    });
    expect(policy.checkConfig({ type: "cloud", packages: { npm: ["@evil/pkg@1.2.3"] } })).toMatchObject({
      type: "rejected",
      field: "config.packages.npm.0",
    });
    expect(policy.checkConfig({ type: "cloud", packages: { pip: ["requests"] } })).toEqual({
      type: "accepted",
    });
  });

  it("lets only allow-listed names through for a manager with an allow list", () => {
    const policy = createEnvironmentConfigPolicy({
      catalog: enabledCatalog,
      packagePolicy: parseSandboxPackagePolicy({ allow: { apt: ["figlet", "jq"] } }),
    });

    expect(policy.checkConfig({ type: "cloud", packages: { apt: ["jq", "figlet"] } })).toEqual({
      type: "accepted",
    });
    expect(policy.checkConfig({ type: "cloud", packages: { apt: ["jq", "nmap"] } })).toEqual({
      type: "rejected",
      field: "config.packages.apt.1",
      message: 'apt package "nmap" is not in the operator allow list',
    });
    // Managers without an allow list stay open.
    expect(policy.checkConfig({ type: "cloud", packages: { pip: ["anything"] } })).toEqual({
      type: "accepted",
    });
  });

  it("checks the image before packages", () => {
    const policy = createEnvironmentConfigPolicy({ catalog: enabledCatalog });
    expect(
      policy.checkConfig({ type: "cloud", image: "nope", packages: { cargo: ["x"] } }),
    ).toMatchObject({ field: "config.image" });
  });
});

describe("packageBaseName", () => {
  it("strips versions, extras and scopes as the policy compares them", () => {
    expect(packageBaseName("pip", "Pandas[excel]>=2.2,<3")).toBe("pandas");
    expect(packageBaseName("pip", "python_pptx==1.0.2")).toBe("python-pptx");
    expect(packageBaseName("pip", "zope.interface~=6.0")).toBe("zope-interface");
    expect(packageBaseName("npm", "@scope/pkg@1.2.3")).toBe("@scope/pkg");
    expect(packageBaseName("npm", "cowsay@1.6.0")).toBe("cowsay");
    expect(packageBaseName("npm", "cowsay")).toBe("cowsay");
    expect(packageBaseName("apt", "python3-bs4")).toBe("python3-bs4");
  });
});

describe("parseSandboxPackagePolicy", () => {
  it("accepts deny and allow lists per manager", () => {
    expect(parseSandboxPackagePolicy({})).toEqual({ deny: {}, allow: {} });
    expect(parseSandboxPackagePolicy({ deny: { pip: ["a"] }, allow: { apt: ["b"] } })).toEqual({
      deny: { pip: ["a"] },
      allow: { apt: ["b"] },
    });
  });

  it("rejects malformed policies with the setting name", () => {
    for (const bad of [null, [], { deny: [] }, { deny: { pip: "a" } }, { deny: { brew: ["a"] } }, { other: {} }]) {
      expect(() => parseSandboxPackagePolicy(bad), JSON.stringify(bad)).toThrow(/SANDBOX_PACKAGE_POLICY/);
    }
  });

  it("reads the policy file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oma-policy-"));
    dirs.push(dir);
    const file = join(dir, "policy.json");
    writeFileSync(file, JSON.stringify({ deny: { npm: ["x"] } }));
    await expect(readSandboxPackagePolicy(file)).resolves.toEqual({ deny: { npm: ["x"] }, allow: {} });
    await expect(readSandboxPackagePolicy(join(dir, "missing.json"))).rejects.toThrow(
      /SANDBOX_PACKAGE_POLICY/,
    );
  });
});
