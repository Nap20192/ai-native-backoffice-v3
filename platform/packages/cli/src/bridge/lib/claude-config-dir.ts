/**
 * Isolated `CLAUDE_CONFIG_DIR` for a claude-acp child.
 *
 * Upstream mirrored the whole `~/.claude/` into `<session cwd>/.claude-config/`
 * with symlinks (credentials, settings with hooks and pre-allowed dirs,
 * projects/ transcripts, history, plugins). That put the owner's login and
 * history inside the agent's working dir and ran the owner's hooks on
 * tenant prompts. This module never reads or links anything from `~/.claude`.
 *
 * The dir lives outside the agent cwd (see sessionClaudeConfigDirPath) and
 * holds only a generated settings.json: no hooks, no allow rules, no extra
 * directories, bypass mode disabled. Claude Code then writes its own state
 * (transcripts of this session only) next to it. Login comes from env set by
 * the daemon (spawn-guard.ts), never from a credentials file here.
 *
 * Fails closed: an error here must abort the spawn, never fall back to the
 * owner's real `~/.claude`.
 */

import { chmod, lstat, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ISOLATED_CLAUDE_SETTINGS = {
  permissions: {
    allow: [] as string[],
    deny: [
      "Read(~/.claude/**)",
      "Read(~/.config/**)",
      "Read(~/.ssh/**)",
      "Read(~/.gnupg/**)",
      "Read(~/.aws/**)",
    ],
    additionalDirectories: [] as string[],
    defaultMode: "default",
    disableBypassPermissionsMode: "disable",
  },
  disableAllHooks: true,
  enableAllProjectMcpServers: false,
};

export async function setupIsolatedClaudeConfigDir(cfgDir: string): Promise<string> {
  await mkdir(cfgDir, { recursive: true, mode: 0o700 });
  if (!(await lstat(cfgDir)).isDirectory()) {
    throw new Error("isolated CLAUDE_CONFIG_DIR refused: path is not a plain directory");
  }
  await chmod(cfgDir, 0o700);
  for (const entry of await readdir(cfgDir)) {
    const path = join(cfgDir, entry);
    if ((await lstat(path)).isSymbolicLink()) await rm(path, { force: true });
  }
  const settingsPath = join(cfgDir, "settings.json");
  await rm(settingsPath, { force: true, recursive: true });
  await writeFile(settingsPath, `${JSON.stringify(ISOLATED_CLAUDE_SETTINGS, null, 2)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return cfgDir;
}
