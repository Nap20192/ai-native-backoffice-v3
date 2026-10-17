// The "Environment" block of the system prompt (docs/plans/environments.md, 4.2-4.3).
//
// The block states only what the platform knows. For a VM from the image
// catalog the facts come from the image manifest and from the snapshot of
// the configuration that VM received. For a host process, a remote process
// or an unknown sandbox the block names no OS, user, shell, path or install
// command. The text is English like the rest of the platform guidance. The
// whole block stays within 1500 characters: lists shrink from 20 items until
// it fits, and the network, search and install lines always stay.

export type EnvironmentExecutor = "vm" | "host" | "remote" | "unknown";
export type EnvironmentWebSearch = "off" | "on" | "filtered";
export type EnvironmentPackageManager = "apt" | "pip" | "npm" | "uv";

export interface EnvironmentPromptPackage {
  name: string;
  version: string;
}

/** Facts about the image, read from its manifest. */
export interface EnvironmentPromptManifest {
  os: string;
  architecture: string;
  user: string;
  shell: string;
  workingDirectory: string;
  python?: { version: string; venv?: string };
  node?: { version: string };
  packageManagers: readonly EnvironmentPackageManager[];
  /** Command line tools to name, for example `jq` or `pdftotext`. */
  tools?: readonly string[];
  packages: {
    pip?: readonly EnvironmentPromptPackage[];
    apt?: readonly EnvironmentPromptPackage[];
    npm?: readonly EnvironmentPromptPackage[];
  };
  fonts?: readonly string[];
}

export type EnvironmentPromptNetworking =
  | { type: "unrestricted" }
  | { type: "limited"; allowPackageManagers: boolean; allowedHosts: readonly string[] };

/** The configuration the VM received when it was created. */
export interface EnvironmentPromptSnapshot {
  networking: EnvironmentPromptNetworking;
  /** Environment packages installed from the layer, with versions. */
  packages?: { pip?: readonly string[]; apt?: readonly string[]; npm?: readonly string[] };
  /** Operator mirrors per manager, addresses only. */
  mirrors?: { pip?: string; apt?: string; npm?: string };
}

export interface EnvironmentPromptInput {
  executor: EnvironmentExecutor;
  manifest?: EnvironmentPromptManifest;
  snapshot?: EnvironmentPromptSnapshot;
  /** Search policy for this session; missing means not available. */
  webSearch?: EnvironmentWebSearch;
}

/** Upper bound of the whole block, tags included. */
export const MAX_ENVIRONMENT_BLOCK_LENGTH = 1500;
/** Lists shrink through these sizes until the block fits. */
const LIST_LIMITS = [20, 10, 5, 2, 0] as const;
/** A single fact such as the OS name; longer values read as "unknown". */
const MAX_FACT_LENGTH = 40;
/** A list item such as a package or a host; longer items only count. */
const MAX_ITEM_LENGTH = 64;
const OUTPUTS_LINE = "Save files the user should keep in /mnt/session/outputs/.";
const INSTALL_MANAGERS = ["pip", "apt", "npm"] as const;
type InstallManager = (typeof INSTALL_MANAGERS)[number];
const REGISTRY_NAMES: Record<InstallManager, string> = { pip: "PyPI", apt: "Debian", npm: "npm" };

// A fact goes into the prompt only as a plain token: no line breaks, no tags,
// so a configured value cannot add instructions of its own.
const SAFE_ITEM = /^[A-Za-z0-9@/*][A-Za-z0-9@/._+:=!~,*()[\]-]*(?: [A-Za-z0-9(),._+-]+)*$/;
const COMPARISON_ITEM = /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\[[A-Za-z0-9._,-]+\])?(?:(?:==|!=|>=|<=|~=|>|<)[A-Za-z0-9.*]+,?)*$/;

function isSafe(item: string, maxLength: number): boolean {
  return item.length <= maxLength && (SAFE_ITEM.test(item) || COMPARISON_ITEM.test(item));
}

function fact(value: string | undefined): string {
  return value !== undefined && isSafe(value, MAX_FACT_LENGTH) ? value : "unknown";
}

/** Up to `limit` safe items; the rest, unsafe ones included, only as a count. */
function list(items: readonly string[] | undefined, limit: number, noun: [string, string]): string {
  const all = items ?? [];
  const shown = all.filter((item) => isSafe(item, MAX_ITEM_LENGTH)).slice(0, limit);
  const hidden = all.length - shown.length;
  if (shown.length === 0) return hidden > 0 ? `${hidden} ${hidden === 1 ? noun[0] : noun[1]}` : "";
  return hidden > 0 ? `${shown.join(", ")} and ${hidden} more` : shown.join(", ");
}

function joinAnd(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function wrap(lines: string[]): string {
  return ["<environment>", ...lines, "</environment>"].join("\n");
}

function hostOf(address: string): string | null {
  try {
    const host = new URL(address).hostname;
    return isSafe(host, MAX_FACT_LENGTH) ? host : null;
  } catch {
    return null;
  }
}

function installCommand(manager: InstallManager): string {
  if (manager === "pip") return "pip install <name>";
  if (manager === "apt") return "apt-get install -y <name>";
  return "npm install -g <name>";
}

function webSearchLine(webSearch: EnvironmentWebSearch | undefined): string {
  if (webSearch === "on") return "Web search: available.";
  if (webSearch === "filtered") return "Web search: available, results only from allowed hosts.";
  return "Web search: not available.";
}

/** Lines of a VM block. `limit` caps every list; null drops the optional lists. */
function vmLines(
  input: EnvironmentPromptInput,
  manifest: EnvironmentPromptManifest,
  snapshot: EnvironmentPromptSnapshot,
  limit: number | null,
): string[] {
  const user = manifest.user === "root" ? "You are root." : `You are the user ${fact(manifest.user)}.`;
  const lines = [
    `This session runs in its own Linux VM: ${fact(manifest.os)}, ${fact(manifest.architecture)}. ${user} Shell: ${fact(manifest.shell)}. Working directory: ${fact(manifest.workingDirectory)}.`,
    `${OUTPUTS_LINE} Everything else, including packages you install, disappears when the session's VM stops.`,
  ];
  const managers = new Set(manifest.packageManagers);
  const preinstalled: string[] = [];
  if (manifest.python) {
    const version = fact(manifest.python.version);
    if (manifest.python.venv && managers.has("pip")) {
      const users = managers.has("uv") ? "python, pip and uv use" : "python and pip use";
      preinstalled.push(`Python ${version} (${users} the venv ${fact(manifest.python.venv)})`);
    } else {
      preinstalled.push(`python3 ${version} ${managers.has("pip") ? "with pip" : "without pip"}`);
    }
  }
  if (manifest.node) preinstalled.push(`Node ${fact(manifest.node.version)}${managers.has("npm") ? " with npm" : ""}`);
  if (limit !== null) {
    const tools = list(manifest.tools, limit, ["tool", "tools"]);
    if (tools) preinstalled.push(tools);
  }
  if (preinstalled.length > 0) lines.push(`Preinstalled: ${preinstalled.join(", ")}.`);
  if (limit !== null) {
    const libraries = list(manifest.packages.pip?.map((pkg) => pkg.name), limit, ["library", "libraries"]);
    if (libraries) lines.push(`Python libraries: ${libraries}.`);
    const fonts = list(manifest.fonts, limit, ["font", "fonts"]);
    if (fonts) lines.push(`Fonts with Cyrillic: ${fonts}.`);
    const layer = INSTALL_MANAGERS.flatMap((manager) => {
      const names = list(snapshot.packages?.[manager], limit, ["package", "packages"]);
      return names ? [`${manager} ${names}`] : [];
    });
    if (layer.length > 0) lines.push(`Environment packages: ${layer.join("; ")}.`);
  }

  // apt needs root; pip and npm need their tools in the image.
  const installable = INSTALL_MANAGERS.filter(
    (manager) => managers.has(manager) && (manager !== "apt" || manifest.user === "root"),
  );
  const networking = snapshot.networking;
  const limited = networking.type === "limited";
  const registriesOpen = !limited || networking.allowPackageManagers;
  const mirrored = registriesOpen ? installable.filter((manager) => snapshot.mirrors?.[manager]) : [];
  const hosts = limited ? list(networking.allowedHosts, limit ?? 0, ["allowed host", "allowed hosts"]) : "";

  if (!limited) {
    lines.push("Network: unrestricted.");
  } else if (networking.allowPackageManagers) {
    const registries = installable.map((manager) => (mirrored.includes(manager) ? `${manager} mirror` : REGISTRY_NAMES[manager]));
    const reachable = [registries.length > 0 ? `package registries (${registries.join(", ")})` : "", hosts]
      .filter(Boolean)
      .join(" and ");
    lines.push(reachable ? `Network: limited. Reachable: ${reachable}. Other hosts fail.` : "Network: none.");
  } else {
    lines.push(hosts ? `Network: limited to ${hosts}.` : "Network: none.");
  }

  if (mirrored.length > 0) {
    const sources = mirrored.map((manager) => `${manager} from ${hostOf(snapshot.mirrors?.[manager] ?? "") ?? "the operator mirror"}`);
    const blocked = limited ? ` Public registries for ${joinAnd(mirrored)} are blocked.` : "";
    lines.push(`Packages come from internal mirrors: ${sources.join(", ")}.${blocked}`);
  }

  lines.push(webSearchLine(input.webSearch));

  if (registriesOpen && installable.length > 0) {
    const commands = installable.map(installCommand).join(", ");
    lines.push(
      `If a library or tool is missing, install it and continue: ${commands}. A missing package is not a reason to stop, and the three-failures rule does not apply to installing it. Tell the user which packages you installed, so they can add them to the environment.`,
    );
  } else {
    lines.push(
      "Package registries are blocked. The environment's packages are already installed. If something else is missing, say what you need and finish with what you have.",
    );
  }
  return lines;
}

function vmBlock(input: EnvironmentPromptInput, manifest: EnvironmentPromptManifest, snapshot: EnvironmentPromptSnapshot): string {
  for (const limit of LIST_LIMITS) {
    const text = wrap(vmLines(input, manifest, snapshot, limit));
    if (text.length <= MAX_ENVIRONMENT_BLOCK_LENGTH) return text;
  }
  // Facts are capped in length, so the block without lists always fits.
  return wrap(vmLines(input, manifest, snapshot, null));
}

export function buildEnvironmentPrompt(input: EnvironmentPromptInput): string {
  switch (input.executor) {
    case "host":
      return wrap([
        "Commands run in a temporary directory on the platform host, not in a VM. Environment packages and network settings are not applied. Do not install system packages.",
      ]);
    case "remote":
      return wrap([
        "Your process runs outside the platform sandbox. The platform's image, packages and network settings do not apply to it.",
      ]);
    case "unknown":
      return wrap([
        OUTPUTS_LINE,
        "The platform does not know this sandbox's OS and tools. Check them with commands before relying on them.",
      ]);
    case "vm":
      if (!input.manifest || !input.snapshot) {
        throw new Error("A VM environment block needs the image manifest and the VM snapshot");
      }
      return vmBlock(input, input.manifest, input.snapshot);
  }
}
