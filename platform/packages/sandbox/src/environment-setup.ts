// Provider-neutral provisioning of a Managed Environment inside a freshly
// created sandbox machine.
//
// The host passes the session's cloud environment config through
// `SandboxFactoryContext.environment`. Adapters that own an isolated machine
// (a micro-VM, a container) run `buildEnvironmentSetupScript` once right after
// the machine exists and map `networking` onto their own egress controls.
// Adapters that run on the host (LocalSubprocess) ignore both: installing
// system packages or filtering egress there would touch the operator's machine.
//
// Packages install system-wide (the sandbox runs as root and is disposable),
// so binaries land on the image's default PATH without a sourced env file.

export type SandboxPackageManager = "apt" | "cargo" | "gem" | "go" | "npm" | "pip";

export type SandboxEnvironmentPackages = Partial<
  Record<SandboxPackageManager, readonly string[]>
>;

export type SandboxEnvironmentNetworking =
  | { type: "unrestricted" }
  | {
      type: "limited";
      allowedHosts: readonly string[];
      allowPackageManagers: boolean;
      allowMcpServers: boolean;
    };

/** Structurally the cloud branch of the managed `EnvironmentConfig`, so a
 * host can pass `{ packages, networking }` of a domain Environment as is. */
export interface SandboxEnvironmentSpec {
  packages?: SandboxEnvironmentPackages;
  networking?: SandboxEnvironmentNetworking;
}

/** Registry hosts opened when networking is limited and the environment
 * allows package managers. The apt entry also covers Ubuntu and Alpine
 * mirrors because `apt` packages fall back to `apk` on Alpine images. */
export const PACKAGE_MANAGER_HOSTS: Readonly<Record<SandboxPackageManager, readonly string[]>> = {
  apt: [
    "deb.debian.org",
    "security.debian.org",
    "archive.ubuntu.com",
    "security.ubuntu.com",
    "dl-cdn.alpinelinux.org",
  ],
  cargo: ["crates.io", "index.crates.io", "static.crates.io"],
  gem: ["rubygems.org", "index.rubygems.org"],
  go: ["proxy.golang.org", "sum.golang.org"],
  npm: ["registry.npmjs.org"],
  pip: ["pypi.org", "files.pythonhosted.org"],
};

const MANAGER_ORDER: readonly SandboxPackageManager[] = ["apt", "pip", "npm", "cargo", "go", "gem"];

/** Non-empty package lists in install order. */
export function environmentPackageLists(
  packages: SandboxEnvironmentPackages | undefined,
): Array<{ manager: SandboxPackageManager; names: string[] }> {
  const lists: Array<{ manager: SandboxPackageManager; names: string[] }> = [];
  for (const manager of MANAGER_ORDER) {
    const names = (packages?.[manager] ?? [])
      .map((name) => name.trim())
      .filter((name) => name.length > 0);
    if (names.length > 0) lists.push({ manager, names });
  }
  return lists;
}

/**
 * POSIX `sh` script that installs every configured package, or `null` when
 * there is nothing to install. Each manager runs in its own subshell chained
 * with `&&` (`set -e` is void on the left of `||`); the first failing section
 * stops the script with that section's exit code and
 * a `[oma-setup] <manager> failed` line on stderr. A missing toolchain exits
 * 127 with a message that names it, instead of a bare "command not found".
 */
export function buildEnvironmentSetupScript(
  packages: SandboxEnvironmentPackages | undefined,
): string | null {
  const lists = environmentPackageLists(packages);
  if (lists.length === 0) return null;
  const lines = ["set -u"];
  for (const { manager, names } of lists) {
    lines.push(
      `echo "[oma-setup] ${manager}: ${names.length} package(s)"`,
      `( ${installCommand(manager, names)} ) || { rc=$?; echo "[oma-setup] ${manager} failed (exit $rc)" >&2; exit $rc; }`,
    );
  }
  lines.push(`echo "[oma-setup] done"`);
  return lines.join("\n");
}

function installCommand(manager: SandboxPackageManager, names: string[]): string {
  const args = names.map(shellQuote).join(" ");
  switch (manager) {
    case "apt":
      return (
        `if command -v apt-get >/dev/null 2>&1; then ` +
        `export DEBIAN_FRONTEND=noninteractive && apt-get update -qq && ` +
        `apt-get install -y -qq --no-install-recommends ${args}; ` +
        `elif command -v apk >/dev/null 2>&1; then apk add --no-cache ${args}; ` +
        `else ${missing("apt-get (or apk)")}; fi`
      );
    case "pip":
      return (
        `if command -v uv >/dev/null 2>&1; then uv pip install --system --break-system-packages ${args}; ` +
        `elif python3 -m pip --version >/dev/null 2>&1; then ` +
        `PIP_BREAK_SYSTEM_PACKAGES=1 python3 -m pip install --no-cache-dir --disable-pip-version-check -q ${args}; ` +
        `else ${missing("python3 with pip (or uv)")}; fi`
      );
    case "npm":
      return `${requireBinary("npm")} && npm install -g --no-fund --no-audit --loglevel=error ${args}`;
    case "cargo":
      return `${requireBinary("cargo")} && cargo install --quiet --root /usr/local ${args}`;
    case "go":
      return `${requireBinary("go")} && for pkg in ${args}; do GOBIN=/usr/local/bin go install "$pkg" || exit $?; done`;
    case "gem":
      return `${requireBinary("gem")} && gem install --no-document ${args}`;
  }
}

function requireBinary(binary: string): string {
  return `command -v ${binary} >/dev/null 2>&1 || { ${missing(binary)}; }`;
}

function missing(what: string): string {
  return `echo "[oma-setup] ${what} not found in the sandbox image" >&2; exit 127`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
