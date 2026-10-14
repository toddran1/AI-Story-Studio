import { z } from "zod";
const selection = z.object({ chapter: z.number().int().positive(), segments: z.array(z.number().int().positive()).min(1).max(1000).optional() }).strict();
export const audioRegenerationInputSchema = z.object({ selections: z.array(selection).min(1).max(2000), rebuildMasters: z.boolean().default(true) }).strict().superRefine((value, context) => {
  if (new Set(value.selections.map(row => row.chapter)).size !== value.selections.length) context.addIssue({ code: "custom", message: "Select each chapter only once" });
}).transform(value => ({ ...value, selections: value.selections.map(row => ({ ...row, ...(row.segments ? { segments: [...new Set(row.segments)].sort((a,b) => a-b) } : {}) })).sort((a,b) => a.chapter-b.chapter) }));
