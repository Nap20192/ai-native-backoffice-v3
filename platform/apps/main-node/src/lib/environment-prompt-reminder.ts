// The "Environment" block as a platform reminder (docs/plans/environments.md,
// 4.2-4.5). main-node puts it first in platformReminders with source
// "environment". composeSystemPrompt adds it to ctx.systemPrompt and Pi sends
// that prompt to the model.
//
// The block states only what the platform knows. A VM is described by two
// sources: the snapshot its sandbox adapter reports (image digest, shell,
// working directory, network, environment packages) and the image manifest
// that platform/sandbox-images/manifest.sh wrote for that digest (OS, user,
// Python, Node, libraries, tools, fonts). A manifest of another digest, or
// none, gives the `unknown` block, which names no OS and no install command.

import {
  buildEnvironmentPrompt,
  type EnvironmentPackageManager,
  type EnvironmentPromptInput,
  type EnvironmentPromptManifest,
  type EnvironmentPromptSnapshot,
  type EnvironmentWebSearch,
} from "@open-managed-agents/agent/harness/environment-prompt";
import {
  supportsEnvironmentSnapshot,
  type SandboxEnvironmentSnapshot,
} from "@open-managed-agents/sandbox";

export const ENVIRONMENT_REMINDER_SOURCE = "environment";

export interface NodeManagedEnvironmentReminderInput {
  /** VM facts the sandbox reports (`environmentSnapshot()`), with the image
   *  manifest of its digest; null when the sandbox reports none. */
  snapshot: SandboxEnvironmentSnapshot | null;
  /** True when agent commands run on the server host (the local subprocess adapter). */
  hostProcess?: boolean;
  /** Search policy of the turn; missing reads as not available. */
  webSearch?: EnvironmentWebSearch;
}

export interface NodeManagedEnvironmentReminder {
  source: typeof ENVIRONMENT_REMINDER_SOURCE;
  text: string;
}

/** Libraries an agent looks for first; the rest follow in manifest order. */
const NOTABLE_PYTHON_LIBRARIES = [
  "python-pptx", "python-docx", "openpyxl", "xlsxwriter", "pypdf", "pdfplumber", "reportlab", "pillow",
  "lxml", "pandas", "numpy", "matplotlib", "requests", "httpx", "beautifulsoup4",
];
/** Packaging tools of the venv, not libraries. */
const PYTHON_TOOLING = new Set(["pip", "setuptools", "wheel"]);
/** Command line tools by the Debian package that installs them. */
const DEBIAN_TOOLS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["git", ["git"]],
  ["curl", ["curl"]],
  ["jq", ["jq"]],
  ["ripgrep", ["rg"]],
  ["poppler-utils", ["pdftotext", "pdftoppm"]],
];
const PACKAGE_MANAGERS: Record<string, EnvironmentPackageManager> = {
  "apt-get": "apt", apt: "apt", pip: "pip", npm: "npm", uv: "uv",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** `{ name, version }` items of a manifest list. */
function packageList(value: unknown): Array<{ name: string; version: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const name = isRecord(item) ? text(item.name) : undefined;
    return name === undefined ? [] : [{ name, version: text((item as Record<string, unknown>).version) ?? "" }];
  });
}

function canonical(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/** `Debian GNU/Linux` and `12 (bookworm)` give `Debian 12 (bookworm)`. */
function osName(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const name = text(value.name)?.replace(/ GNU\/Linux$/, "");
  const version = text(value.version) ?? text(value.version_id);
  if (name !== undefined) return version === undefined ? name : `${name} ${version}`;
  return text(value.pretty_name)?.replace(" GNU/Linux", "");
}

function pythonLibraries(value: unknown): Array<{ name: string; version: string }> {
  const rank = (name: string) => {
    const index = NOTABLE_PYTHON_LIBRARIES.indexOf(canonical(name));
    return index < 0 ? NOTABLE_PYTHON_LIBRARIES.length : index;
  };
  return packageList(value)
    .filter((item) => !PYTHON_TOOLING.has(canonical(item.name)))
    .map((item, order) => ({ item, order }))
    .sort((a, b) => rank(a.item.name) - rank(b.item.name) || a.order - b.order)
    .map(({ item }) => item);
}

function tools(manifest: Record<string, unknown>): string[] {
  const installed = new Set(packageList(manifest.dpkg).map((item) => item.name));
  const found = DEBIAN_TOOLS.flatMap(([pkg, commands]) => (installed.has(pkg) ? [...commands] : []));
  if (installed.has("tesseract-ocr")) {
    const languages = [...installed]
      .filter((name) => name.startsWith("tesseract-ocr-") && name !== "tesseract-ocr-osd")
      .map((name) => name.slice("tesseract-ocr-".length))
      .sort();
    found.push(languages.length > 0 ? `tesseract (${languages.join(", ")})` : "tesseract");
  }
  const office = /LibreOffice (\d+\.\d+)/.exec(text(manifest.libreoffice_version) ?? "");
  if (office !== null) found.push(`LibreOffice ${office[1]} (soffice --headless)`);
  return found;
}

/** Font families with Cyrillic, from `fc-list` lines `Family[,Alias]\tfile`. */
function fonts(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const families = value.flatMap((line) => {
    const family = typeof line === "string" ? text(line.split("\t")[0]?.split(",")[0]) : undefined;
    return family === undefined ? [] : [family];
  });
  return [...new Set(families)].sort();
}

/**
 * The facts the block needs, read from image-manifest.json. Null when the
 * manifest lacks the OS, architecture, user, shell or package managers: the
 * block then calls the sandbox unknown instead of guessing.
 */
export function promptManifestFromImageManifest(
  manifest: unknown,
  vm: { workingDirectory: string; shell?: string | null },
): EnvironmentPromptManifest | null {
  if (!isRecord(manifest)) return null;
  const os = osName(manifest.os);
  const architecture = text(manifest.architecture);
  const user = text(manifest.user);
  // The shell the adapter found in the VM wins over the one the build saw.
  const shell = vm.shell ?? text(manifest.shell)?.split("/").at(-1);
  if (!os || !architecture || !user || !shell || !Array.isArray(manifest.package_managers)) return null;
  const packageManagers = [...new Set(manifest.package_managers.flatMap((name) => {
    const manager = typeof name === "string" ? PACKAGE_MANAGERS[name] : undefined;
    return manager === undefined ? [] : [manager];
  }))];
  const python = /^(\d+\.\d+)/.exec(text(manifest.python_version) ?? "")?.[1];
  const venv = text(manifest.venv);
  const node = /^v?(\d+)/.exec(text(manifest.node_version) ?? "")?.[1];
  return {
    os,
    architecture,
    user,
    shell,
    workingDirectory: vm.workingDirectory,
    ...(python === undefined ? {} : { python: venv === undefined ? { version: python } : { version: python, venv } }),
    ...(node === undefined ? {} : { node: { version: node } }),
    packageManagers,
    tools: tools(manifest),
    packages: { pip: pythonLibraries(manifest.pip) },
    fonts: fonts(manifest.fonts),
  };
}

function promptSnapshot(snapshot: SandboxEnvironmentSnapshot): EnvironmentPromptSnapshot {
  const { networking, packages } = snapshot;
  return {
    networking: networking.type === "limited"
      ? { type: "limited", allowPackageManagers: networking.allowPackageManagers, allowedHosts: [...networking.allowedHosts] }
      : { type: "unrestricted" },
    packages: {
      ...(packages.pip === undefined ? {} : { pip: [...packages.pip] }),
      ...(packages.apt === undefined ? {} : { apt: [...packages.apt] }),
      ...(packages.npm === undefined ? {} : { npm: [...packages.npm] }),
    },
  };
}

/** VM facts, or null when the manifest does not prove them for this VM's image. */
function vmFacts(snapshot: SandboxEnvironmentSnapshot): EnvironmentPromptManifest | null {
  const { digest, manifest } = snapshot.image;
  if (digest === null || !isRecord(manifest) || manifest.image_digest !== digest) return null;
  return promptManifestFromImageManifest(manifest, snapshot);
}

/**
 * The reminder main-node puts first in platformReminders. The executor
 * follows the sandbox: `vm` for a sandbox with a snapshot and a manifest of
 * its digest, `host` for the local subprocess adapter, `unknown` otherwise.
 */
export function buildNodeManagedEnvironmentReminder(
  input: NodeManagedEnvironmentReminderInput,
): NodeManagedEnvironmentReminder {
  const options = input.webSearch === undefined ? {} : { webSearch: input.webSearch };
  let prompt: EnvironmentPromptInput = { executor: "unknown", ...options };
  if (input.snapshot !== null) {
    const manifest = vmFacts(input.snapshot);
    if (manifest !== null) prompt = { executor: "vm", manifest, snapshot: promptSnapshot(input.snapshot), ...options };
  } else if (input.hostProcess === true) {
    prompt = { executor: "host", ...options };
  }
  return { source: ENVIRONMENT_REMINDER_SOURCE, text: buildEnvironmentPrompt(prompt) };
}

/**
 * The reminder of the sandbox a turn runs in. A sandbox without a snapshot
 * gets the `unknown` block: the turn cannot tell which adapter it has.
 * Search is available when the agent's tools include `web_search`; the
 * search runs on the server, not in the VM.
 */
export function environmentReminderOfSandbox(
  sandbox: unknown,
  tools: Readonly<Record<string, unknown>>,
): NodeManagedEnvironmentReminder {
  return buildNodeManagedEnvironmentReminder({
    snapshot: supportsEnvironmentSnapshot(sandbox) ? sandbox.environmentSnapshot() : null,
    webSearch: Object.hasOwn(tools, "web_search") ? "on" : "off",
  });
}
