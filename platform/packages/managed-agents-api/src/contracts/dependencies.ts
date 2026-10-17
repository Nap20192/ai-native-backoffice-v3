// Wire shape of a dependency report (docs/plans/crud.md, 1.2). OMA only:
// GET /v1/oma/dependencies/:kind/:id and the 409 dependency_conflict_error
// of archive and delete carry it.
import { z } from "zod";

export const DEPENDENCY_TARGET_KINDS = [
  "agent",
  "environment",
  "session",
  "deployment",
  "file",
  "skill",
  "skill_version",
  "memory_store",
  "memory",
  "session_resource",
  "model",
  "vault",
] as const;

export const DEPENDENCY_ENTRY_KINDS = [
  "agent",
  "session",
  "deployment",
  "environment_work",
  "file",
  "skill_version",
  "memory",
  "credential",
  "model_card",
] as const;

export const dependencyEntrySchema = z
  .object({
    kind: z.enum(DEPENDENCY_ENTRY_KINDS),
    id: z.string().min(1),
    name: z.string().nullable(),
    status: z.string().nullable(),
    note: z.string().nullable(),
  })
  .strict();

export const dependencyReportSchema = z
  .object({
    blocking: z.array(dependencyEntrySchema).max(50),
    affected: z.array(dependencyEntrySchema).max(50),
    truncated: z.boolean(),
  })
  .strict();

export type DependencyReportBody = z.infer<typeof dependencyReportSchema>;

export const dependencyQuerySchema = z
  .object({
    kind: z.enum(DEPENDENCY_TARGET_KINDS),
    id: z.string().min(1),
    operation: z.enum(["archive", "delete"]),
    version: z.string().min(1).optional(),
  })
  .strict();
