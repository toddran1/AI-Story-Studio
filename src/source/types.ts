import { z } from "zod";

export const sourceTypeSchema = z.enum(["text", "epub", "docx", "manual", "original"]);
export type SourceType = z.infer<typeof sourceTypeSchema>;

export const sourceWarningSchema = z.object({
  code: z.enum([
    "chapter_number_gap", "duplicate_chapter_number", "unnumbered_section", "empty_section",
    "ambiguous_heading", "unsupported_epub_structure", "missing_metadata", "invalid_filename",
  ]),
  message: z.string(),
  sourceId: z.string().optional(),
});
export type SourceWarning = z.infer<typeof sourceWarningSchema>;

export const chapterReferenceSchema = z.object({
  chapter: z.number().int().positive(),
  sourceId: z.string().min(1),
  sourceTitle: z.string().optional(),
  originalTitle: z.string().optional(),
  sourceType: sourceTypeSchema,
  metadata: z.record(z.string(), z.unknown()).default({}),
});
export type ChapterReference = z.infer<typeof chapterReferenceSchema>;

export type RawChapter = { ref: ChapterReference; text: string };
export type UnnumberedSection = { sourceId: string; title?: string };
export type SourceInspection = {
  sourcePath: string;
  sourceType: SourceType;
  title?: string;
  author?: string;
  language?: string;
  fingerprint: string;
  chapters: RawChapter[];
  unnumberedSections: UnnumberedSection[];
  warnings: SourceWarning[];
};

export type SourceInspectOptions = {
  splitChapters?: boolean;
  chapter?: number;
  allowGaps?: boolean;
  semanticType?: SourceType;
};

export interface StorySourceProvider {
  readonly type: SourceType;
  inspect(sourcePath: string, options?: SourceInspectOptions): Promise<SourceInspection>;
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
export const sourceManifestSchema = z.object({
  version: z.literal(1),
  adapterVersion: z.string(),
  type: sourceTypeSchema,
  origin: z.object({ path: z.string(), name: z.string() }),
  fingerprint: sha256Schema,
  importedAt: z.iso.datetime(),
  title: z.string().optional(),
  author: z.string().optional(),
  language: z.string().optional(),
  warnings: z.array(sourceWarningSchema),
  unnumberedSections: z.array(z.object({ sourceId: z.string(), title: z.string().optional() })),
  chapters: z.array(z.object({
    chapter: z.number().int().positive(),
    file: z.string().regex(/^chapters\/\d{4,}\.txt$/),
    fingerprint: sha256Schema,
    ref: chapterReferenceSchema,
  })),
}).superRefine((manifest, context) => {
  const seen = new Set<number>();
  for (let index = 0; index < manifest.chapters.length; index++) {
    const item = manifest.chapters[index]!; const fileNumber = Number(/^chapters\/(\d+)\.txt$/.exec(item.file)?.[1]);
    if (item.ref.chapter !== item.chapter) context.addIssue({ code: "custom", path: ["chapters", index, "ref", "chapter"], message: "Reference chapter must match manifest chapter" });
    if (fileNumber !== item.chapter) context.addIssue({ code: "custom", path: ["chapters", index, "file"], message: "Materialized filename must match manifest chapter" });
    if (item.ref.sourceType !== manifest.type) context.addIssue({ code: "custom", path: ["chapters", index, "ref", "sourceType"], message: "Reference source type must match manifest type" });
    if (seen.has(item.chapter)) context.addIssue({ code: "custom", path: ["chapters", index, "chapter"], message: "Manifest chapter numbers must be unique" });
    seen.add(item.chapter);
  }
});
export type SourceManifest = z.infer<typeof sourceManifestSchema>;
