import { z } from "zod";

export const preferencesSchema = z.object({
  schemaVersion: z.literal(1),
  preferredLanguages: z.array(z.string()),
  preferredDifficulty: z.enum(["BEGINNER", "INTERMEDIATE", "ADVANCED"]).nullable(),
  defaultMode: z.enum(["GUIDED", "EXPERT"]),
  workspaceRoot: z.string().nullable(),
});

export type PersistedPreferences = z.infer<typeof preferencesSchema>;
