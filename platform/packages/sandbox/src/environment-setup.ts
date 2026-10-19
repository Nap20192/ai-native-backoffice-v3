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
// pip installs into the python3 that PATH resolves: the venv of a catalog
// image, the system Python elsewhere.

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

/** VM resources; null keeps the adapter's server setting. */
export interface SandboxVmResources {
  diskGb: number | null;
  memoryMib: number | null;
  cpus: number | null;
}

/** Shell that runs agent commands: bash, or POSIX sh on an image without it. */
export type SandboxShell = "bash" | "sh";

/**
 * An image of the operator's sandbox image catalog (docs/plans/environments.md,
 * 1.5 and 1.6) that the host resolved from the environment's `config.image`.
 * The key picks the image, the digest fixes its content. Adapters that do not
 * choose an image ignore it.
 */
export interface SandboxEnvironmentImage {
  /** Catalog key, for example `workplace`. */
  key: string;
  /** An OCI layout directory on the host, or a registry reference pinned with `@sha256:`. */
  source: { type: "oci"; dir: string } | { type: "registry"; reference: string };
  /** OCI manifest digest the catalog verified. */
  digest: string;
  /** sha256 of the image manifest file the catalog read; null without one. */
  manifestSha256: string | null;
  /** image-manifest.json of this digest as the catalog read it; null without
   *  one. The VM snapshot keeps it for the prompt block. */
  manifest: Readonly<Record<string, unknown>> | null;
  resources: SandboxVmResources;
  /** Shell of the image from its manifest; null makes the adapter look for bash. */
  shell: SandboxShell | null;
}

/** Structurally the cloud branch of the managed `EnvironmentConfig`, so a
 * host can pass `{ packages, networking }` of a domain Environment as is. */
export interface SandboxEnvironmentSpec {
  packages?: SandboxEnvironmentPackages;
  networking?: SandboxEnvironmentNetworking;
  /** Catalog image of the VM. Absent: the adapter's server image, as before the catalog. */
  image?: SandboxEnvironmentImage;
}

/** Egress the VM got: open, a host allowlist, or no network at all. */
export type SandboxEgress =
  | { type: "unrestricted" }
  | { type: "allowlist"; hosts: string[] }
  | { type: "none" };

/**
 * What a sandbox VM is created with (docs/plans/environments.md, 4.5): the
 * facts the "Environment" prompt block states. The adapter fixes them once
 * per VM, image manifest included, so a live VM keeps its block while
 * someone edits the environment or rebuilds the catalog. Host paths stay out.
 */
export interface SandboxEnvironmentSnapshot {
  image: {
    /** Catalog key; null for the adapter's server image. */
    key: string | null;
    /** Registry reference; null for an OCI layout of the catalog. */
    reference: string | null;
    /** Verified manifest digest; null for the server image. */
    digest: string | null;
    manifestSha256: string | null;
    /** image-manifest.json of `digest`, frozen; null for the server image or
     *  a catalog entry without one. */
    manifest: Readonly<Record<string, unknown>> | null;
  };
  /** Null until the adapter has looked for bash in the VM. */
  shell: SandboxShell | null;
  workingDirectory: string;
  /** The environment networking the VM received; unrestricted when absent. */
  networking: SandboxEnvironmentNetworking;
  egress: SandboxEgress;
  /** Environment packages the VM installs when it boots, as configured. */
  packages: Partial<Record<SandboxPackageManager, string[]>>;
  resources: SandboxVmResources;
  /** Set once the VM is up with its packages installed. */
  vm: { readyAt: string; readyMs: number } | null;
}

export type SandboxEnvironmentErrorCode = "image_changed_on_disk" | "image_unavailable" | "packages_failed";

/** The install of the environment packages that failed, read from the output
 *  of {@link buildEnvironmentSetupScript}. */
export interface SandboxPackagesFailure {
  /** The manager whose section failed; null when the output names none. */
  manager: SandboxPackageManager | null;
  /** Exit code of the install script; null when it did not exit. */
  exitCode: number | null;
  /** The end of the install output, at most {@link SETUP_OUTPUT_TAIL_LENGTH} characters. */
  outputTail: string;
}

/**
 * The sandbox cannot boot the VM its environment describes: the image is
 * unknown or changed on disk (no VM was created), or the environment
 * packages did not install (the VM was stopped). LiteBox fails every later
 * call of that sandbox with the same error.
 */
export class SandboxEnvironmentError extends Error {
  override name = "SandboxEnvironmentError";

  constructor(
    readonly code: SandboxEnvironmentErrorCode,
    message: string,
    /** Set for `packages_failed`. */
    readonly packages: SandboxPackagesFailure | null = null,
  ) {
    super(message);
  }
}

/** True for a {@link SandboxEnvironmentError}, also one from another copy of this package. */
export function isSandboxEnvironmentError(value: unknown): value is SandboxEnvironmentError {
  if (value instanceof SandboxEnvironmentError) return true;
  return value instanceof Error
    && value.name === "SandboxEnvironmentError"
    && typeof (value as { code?: unknown }).code === "string";
}

export const SETUP_OUTPUT_TAIL_LENGTH = 600;

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

/**
 * The failure of a setup script run, from its combined output. The manager
 * is the one of the `[oma-setup] <manager> failed` line; without that line
 * (the run was killed or timed out) it is the last section that started.
 */
export function environmentSetupFailure(output: string, exitCode: number | null): SandboxPackagesFailure {
  const managers = MANAGER_ORDER.join("|");
  const failed = [...output.matchAll(new RegExp(`\\[oma-setup\\] (${managers}) failed \\(exit -?\\d+\\)`, "g"))].at(-1);
  const started = [...output.matchAll(new RegExp(`\\[oma-setup\\] (${managers}): \\d+ package\\(s\\)`, "g"))].at(-1);
  const manager = (failed?.[1] ?? started?.[1] ?? null) as SandboxPackageManager | null;
  return { manager, exitCode, outputTail: output.slice(-SETUP_OUTPUT_TAIL_LENGTH) };
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
      // The python3 first on PATH: on a catalog image that is the /opt/venv
      // shim in /usr/local/bin. `uv pip install --system` would pass over the
      // venv for the system Python. The break-system-packages flags only
      // matter for an image whose python3 is the system Python.
      return (
        `py=$(command -v python3) || py=""; ` +
        `if [ -n "$py" ] && command -v uv >/dev/null 2>&1; then ` +
        `uv pip install --python "$py" --break-system-packages ${args}; ` +
        `elif [ -n "$py" ] && "$py" -m pip --version >/dev/null 2>&1; then ` +
        `PIP_BREAK_SYSTEM_PACKAGES=1 "$py" -m pip install --no-cache-dir --disable-pip-version-check -q ${args}; ` +
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
