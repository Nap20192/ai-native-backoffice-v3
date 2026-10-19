/** Platform skill mount metadata for assembly-layer exposure (PR3+). */
export interface SkillMountDescriptor {
  skillId: string;
  name: string;
  description: string;
  mountRoot: string;
  body?: string;
  source?: "builtin" | "custom";
}

export function skillMountRoot(skillId: string, requestedVersion: string): string {
  return `/workspace/.openma/skills/${encodeURIComponent(skillId)}/${encodeURIComponent(requestedVersion)}/`;
}

// No hardcoded built-in skills.
// All skills are managed via the /v1/skills API. On Node, the platform skills
// docx/pdf/pptx/xlsx ship as files in platform/skills/builtin (MIT, see each
// ATTRIBUTION.md) and join every workspace through BuiltinSkillOverlayStore.
// Do not import github.com/anthropics/skills: its license forbids copies.
