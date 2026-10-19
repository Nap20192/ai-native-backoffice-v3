import { describe, expect, it } from "vitest";
import { buildEnvironmentPrompt } from "../src/harness/environment-prompt.js";

const manifest = {
  os: "Debian 12 (bookworm)", architecture: "x86_64", user: "root", shell: "bash",
  workingDirectory: "/workspace", python: { version: "3.11", venv: "/opt/venv" },
  node: { version: "22" }, packageManagers: ["apt", "pip", "npm"] as const,
  packages: { pip: [{ name: "python-pptx", version: "1.0.2" }], apt: [], npm: [] },
  fonts: ["DejaVu", "Liberation"],
};
const snapshot = { networking: { type: "unrestricted" as const }, packages: { pip: ["duckdb==1.1.3"] } };

describe("environment prompt facts", () => {
  it("uses the VM manifest and frozen configuration", () => {
    const prompt = buildEnvironmentPrompt({ executor: "vm", manifest, snapshot, webSearch: "on" });
    for (const fact of ["<environment>", "Debian 12", "You are root", "Shell: bash", "/workspace",
      "/mnt/session/outputs/", "/opt/venv", "python-pptx", "duckdb==1.1.3", "Network: unrestricted.",
      "Web search: available.", "pip install", "apt-get install", "npm install"])
      expect(prompt).toContain(fact);
    expect(prompt.length).toBeLessThanOrEqual(1500);
  });
  it("does not invent VM facts for host, remote or unknown executors", () => {
    for (const executor of ["host", "remote", "unknown"] as const) {
      const prompt = buildEnvironmentPrompt({ executor, manifest, snapshot });
      for (const fact of ["Debian", "root", "/opt/venv", "bash", "pip install", "Network: unrestricted"])
        expect(prompt).not.toContain(fact);
    }
    expect(buildEnvironmentPrompt({ executor: "host" })).toContain("Do not install system packages.");
    expect(buildEnvironmentPrompt({ executor: "remote" })).toContain("outside the platform sandbox");
    expect(buildEnvironmentPrompt({ executor: "unknown" })).toContain("Check them with commands");
  });
  // The legacy image has the Debian system Python without pip and without a
  // venv. The block does not promise pip, it says how to get it: pip from apt,
  // then installs with --break-system-packages (PEP 668 on Debian 12).
  it("never promises venv or pip for legacy images and names the system pip flag", () => {
    const legacy = { ...manifest, python: { version: "3.11" }, packageManagers: ["apt", "npm"] as const, packages: { apt: [], pip: [], npm: [] } };
    const prompt = buildEnvironmentPrompt({ executor: "vm", manifest: legacy, snapshot });
    expect(prompt).toContain("python3 3.11 without pip");
    expect(prompt).not.toContain("/opt/venv");
    expect(prompt).not.toContain("pip install <name>");
    expect(prompt).toContain("apt-get install -y python3-pip");
    expect(prompt).toContain("pip install --break-system-packages <name>");
    expect(prompt.length).toBeLessThanOrEqual(1500);

    const closed = buildEnvironmentPrompt({ executor: "vm", manifest: legacy,
      snapshot: { networking: { type: "limited", allowPackageManagers: false, allowedHosts: [] } } });
    expect(closed).not.toContain("pip install");
    expect(closed).not.toContain("python3-pip");

    const registries = buildEnvironmentPrompt({ executor: "vm", manifest: legacy,
      snapshot: { networking: { type: "limited", allowPackageManagers: true, allowedHosts: [] } } });
    expect(registries).toContain("Reachable: package registries (Debian, npm).");
    expect(registries).not.toContain("python3-pip");
  });
  it("installs into the system Python with the flag when the image has pip but no venv", () => {
    const system = { ...manifest, python: { version: "3.11" } };
    const prompt = buildEnvironmentPrompt({ executor: "vm", manifest: system, snapshot });
    expect(prompt).toContain("python3 3.11 with pip");
    expect(prompt).toContain("pip install --break-system-packages <name>");
    expect(prompt).not.toContain("pip install <name>");
    expect(prompt).not.toContain("python3-pip");
  });
  it("keeps plain pip install for the venv of a catalog image", () => {
    const prompt = buildEnvironmentPrompt({ executor: "vm", manifest, snapshot });
    expect(prompt).toContain("Python 3.11 (python and pip use the venv /opt/venv)");
    expect(prompt).toContain("pip install <name>");
    expect(prompt).not.toContain("break-system-packages");
  });
  it("describes closed registries without recommending installation", () => {
    const prompt = buildEnvironmentPrompt({ executor: "vm", manifest,
      snapshot: { networking: { type: "limited", allowPackageManagers: false, allowedHosts: [] } } });
    expect(prompt).toContain("Network: none.");
    expect(prompt).toContain("Package registries are blocked.");
    expect(prompt).not.toContain("pip install");
    expect(prompt).toContain("Web search: not available.");
  });
  it("names allowed hosts, registries, mirrors and filtered search", () => {
    const prompt = buildEnvironmentPrompt({ executor: "vm", manifest, webSearch: "filtered",
      snapshot: { networking: { type: "limited", allowPackageManagers: true, allowedHosts: ["example.org"] },
        mirrors: { pip: "https://mirror.example.org/simple" } } });
    expect(prompt).toContain("Network: limited");
    expect(prompt).toContain("example.org");
    expect(prompt).toContain("mirror.example.org");
    expect(prompt).toContain("Public registries for pip are blocked.");
    expect(prompt).toContain("Web search: available, results only from allowed hosts.");
    expect(prompt).toContain("If a library or tool is missing, install it and continue");
  });
  it("limits libraries to 20 and keeps a bounded block", () => {
    const prompt = buildEnvironmentPrompt({ executor: "vm", snapshot, manifest: { ...manifest,
      packages: { ...manifest.packages, pip: Array.from({ length: 40 }, (_, i) => ({ name: `library${i}`, version: "1.0" })) },
    } });
    expect(prompt).toContain("library19");
    expect(prompt).not.toContain("library20");
    expect(prompt.length).toBeLessThanOrEqual(1500);
  });
  it("keeps the whole block within 1500 characters for the largest valid inputs", () => {
    const long = (prefix: string, length: number) => (i: number) => `${prefix}${i}`.padEnd(length, "x");
    const big = { ...manifest,
      tools: Array.from({ length: 30 }, (_, i) => long("tool", 60)(i)),
      packages: { ...manifest.packages, pip: Array.from({ length: 40 }, (_, i) => ({ name: long("lib", 214)(i), version: "1.0" })) },
      fonts: Array.from({ length: 30 }, (_, i) => long("Font", 60)(i)),
    };
    const prompt = buildEnvironmentPrompt({ executor: "vm", manifest: big, webSearch: "filtered",
      snapshot: {
        networking: { type: "limited", allowPackageManagers: true,
          allowedHosts: Array.from({ length: 40 }, (_, i) => `${long("h", 60)(i)}.example.org`) },
        packages: { pip: Array.from({ length: 30 }, (_, i) => `${long("p", 200)(i)}==1.0`),
          apt: Array.from({ length: 30 }, (_, i) => long("a", 100)(i)), npm: Array.from({ length: 30 }, (_, i) => long("n", 100)(i)) },
        mirrors: { pip: `https://${"m".repeat(60)}.example.org/simple`, apt: `https://${"d".repeat(60)}.example.org/debian`,
          npm: `https://${"r".repeat(60)}.example.org/` },
      } });
    expect(prompt.length).toBeLessThanOrEqual(1500);
    // The network, search and install facts survive the cut.
    for (const fact of ["You are root", "Network: limited", "Public registries for pip", "Other hosts fail.",
      "Web search: available, results only from allowed hosts.", "If a library or tool is missing, install it and continue"])
      expect(prompt).toContain(fact);
  });
  it.each([10, 40, 41, 64, 300])("stays within 1500 characters with %i character facts", (length) => {
    const value = "f".repeat(length);
    const prompt = buildEnvironmentPrompt({ executor: "vm", webSearch: "on",
      manifest: { ...manifest, os: value, architecture: value, user: value, shell: value, workingDirectory: value,
        python: { version: value, venv: `/${value}` }, node: { version: value }, packageManagers: ["apt", "pip", "npm", "uv"],
        tools: Array.from({ length: 30 }, (_, i) => `${value}${i}`) },
      snapshot: { networking: { type: "limited", allowPackageManagers: true, allowedHosts: Array.from({ length: 30 }, (_, i) => `${value}${i}.org`) },
        mirrors: { pip: `https://${value}.org/`, apt: `https://${value}.net/`, npm: `https://${value}.com/` } } });
    expect(prompt.length).toBeLessThanOrEqual(1500);
    expect(prompt).toContain("Other hosts fail.");
    expect(prompt).toContain("If a library or tool is missing, install it and continue");
  });
  it("requires facts for a known VM instead of fabricating defaults", () => {
    expect(() => buildEnvironmentPrompt({ executor: "vm" })).toThrow(/manifest|snapshot/i);
  });
});
