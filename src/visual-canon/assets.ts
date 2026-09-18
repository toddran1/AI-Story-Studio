import { rm } from "node:fs/promises";
import {
  VisualReferenceExtension,
  visualReferenceExtensionSchema,
} from "../domain/visual-profile.js";
import { visualProfileRefPath } from "../storage/paths.js";
import { exists } from "../storage/story-files.js";

export const SUPPORTED_VISUAL_REFERENCE_EXTENSIONS: readonly VisualReferenceExtension[] = [
  "png",
  "jpg",
  "jpeg",
  "webp",
] as const;

export function normalizeVisualReferenceExtension(raw: string): VisualReferenceExtension {
  if (!raw || typeof raw !== "string") {
    throw new Error("Invalid reference image extension: empty value");
  }
  const cleaned = raw.trim().toLowerCase().replace(/^\./, "");
  const parsed = visualReferenceExtensionSchema.safeParse(cleaned);
  if (!parsed.success) {
    throw new Error(
      `Unsupported reference image format '${raw}'. Supported formats: PNG, JPG, JPEG, WEBP.`
    );
  }
  return parsed.data;
}

export function isVisualReferenceExtension(raw: string): raw is VisualReferenceExtension {
  if (!raw || typeof raw !== "string") return false;
  const cleaned = raw.trim().toLowerCase().replace(/^\./, "");
  return visualReferenceExtensionSchema.safeParse(cleaned).success;
}

export function resolveVisualReferencePath(
  root: string,
  slug: string,
  entityId: string,
  refId: string,
  ext: string
): string {
  const normalized = normalizeVisualReferenceExtension(ext);
  return visualProfileRefPath(root, slug, entityId, refId, normalized);
}

export function mimeForVisualReferenceExtension(ext: VisualReferenceExtension): string {
  switch (ext) {
    case "webp":
      return "image/webp";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
  }
}


/**
 * Controlled asset discovery: searches strictly inside the entity's Visual Canon directory
 * for supported extensions. Never reads arbitrary or persisted filesystem paths.
 */
export async function findVisualReferenceFile(
  root: string,
  slug: string,
  entityId: string,
  refId: string,
  hintExt?: string
): Promise<{ path: string; ext: VisualReferenceExtension } | undefined> {
  const checkOrder: VisualReferenceExtension[] = [];

  if (hintExt && isVisualReferenceExtension(hintExt)) {
    const normalizedHint = normalizeVisualReferenceExtension(hintExt);
    checkOrder.push(normalizedHint);
  }

  for (const ext of SUPPORTED_VISUAL_REFERENCE_EXTENSIONS) {
    if (!checkOrder.includes(ext)) {
      checkOrder.push(ext);
    }
  }

  for (const ext of checkOrder) {
    const candidate = visualProfileRefPath(root, slug, entityId, refId, ext);
    if (await exists(candidate)) {
      return { path: candidate, ext };
    }
  }

  return undefined;
}

export interface VisualReferenceCleanupError {
  extension: VisualReferenceExtension;
  code?: string;
  message: string;
}

export interface ControlledDeletionResult {
  deletedCount: number;
  wasMissing: boolean;
  errors: VisualReferenceCleanupError[];
}

/**
 * Controlled asset deletion: removes files strictly by reconstructing the allowed path
 * for each supported extension. Never trusts or deletes arbitrary persisted image paths.
 */
export async function deleteControlledVisualReferenceFiles(
  root: string,
  slug: string,
  entityId: string,
  refId: string
): Promise<ControlledDeletionResult> {
  let deletedCount = 0;
  const errors: VisualReferenceCleanupError[] = [];

  for (const ext of SUPPORTED_VISUAL_REFERENCE_EXTENSIONS) {
    const candidate = visualProfileRefPath(root, slug, entityId, refId, ext);
    let candidateExists = false;
    try {
      candidateExists = await exists(candidate);
    } catch (err: unknown) {
      const nodeErr = err as NodeJS.ErrnoException;
      if (nodeErr?.code !== "ENOENT") {
        errors.push({
          extension: ext,
          code: typeof nodeErr?.code === "string" ? nodeErr.code : undefined,
          message: nodeErr?.message ? String(nodeErr.message) : "Failed to inspect reference file",
        });
      }
    }

    if (candidateExists) {
      try {
        await rm(candidate, { force: true });
        deletedCount++;
      } catch (err: unknown) {
        const nodeErr = err as NodeJS.ErrnoException;
        if (nodeErr?.code !== "ENOENT") {
          errors.push({
            extension: ext,
            code: typeof nodeErr?.code === "string" ? nodeErr.code : undefined,
            message: nodeErr?.message ? String(nodeErr.message) : "Failed to remove reference file",
          });
        }
      }
    }
  }

  return {
    deletedCount,
    wasMissing: deletedCount === 0 && errors.length === 0,
    errors,
  };
}

/**
 * Removes a single newly-created controlled visual reference file (e.g. orphan cleanup).
 */
export async function removeControlledVisualReferenceFile(
  root: string,
  slug: string,
  entityId: string,
  refId: string,
  ext: string
): Promise<void> {
  const filePath = resolveVisualReferencePath(root, slug, entityId, refId, ext);
  await rm(filePath, { force: true });
}

