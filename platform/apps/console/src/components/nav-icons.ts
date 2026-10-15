import type { ComponentType } from "react";
import {
  BotIcon,
  BoxesIcon,
  CpuIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  FolderIcon,
  GaugeIcon,
  KeyRoundIcon,
  LockKeyholeIcon,
  MessagesSquareIcon,
  PuzzleIcon,
  TerminalIcon,
  UsersIcon,
} from "lucide-react";

export type NavIcon = ComponentType<{ className?: string }>;

/**
 * Значки разделов меню и командной палитры. Только lucide-react, как в
 * портале DDC, чтобы один раздел выглядел одинаково в обоих местах.
 */
export const NAV_ICONS = {
  dashboard: GaugeIcon,
  agents: BotIcon,
  sessions: MessagesSquareIcon,
  files: FolderIcon,
  evals: FlaskConicalIcon,
  environments: BoxesIcon,
  vaults: LockKeyholeIcon,
  skills: PuzzleIcon,
  memory: DatabaseIcon,
  modelCards: CpuIcon,
  members: UsersIcon,
  apiKeys: KeyRoundIcon,
  runtimes: TerminalIcon,
} satisfies Record<string, NavIcon>;
