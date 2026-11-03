/** Shared by the server and browser. Unknown work is conservatively story-wide. */
export type OperationScope = { all?: boolean; chapters?: number[]; from?: number; to?: number; resources?: string[] };
export function scopesConflict(a: OperationScope, b: OperationScope): boolean {
  if (a.all || b.all) return true;
  if (a.resources?.some(resource => b.resources?.includes(resource))) return true;
  const contains = (scope: OperationScope, chapter: number) => scope.chapters?.includes(chapter) || (scope.from !== undefined && chapter >= scope.from && chapter <= (scope.to ?? Number.MAX_SAFE_INTEGER));
  if (a.chapters?.some(chapter => contains(b, chapter)) || b.chapters?.some(chapter => contains(a, chapter))) return true;
  return a.from !== undefined && b.from !== undefined && a.from <= (b.to ?? Number.MAX_SAFE_INTEGER) && b.from <= (a.to ?? Number.MAX_SAFE_INTEGER);
}
export function scopeIncludesChapter(scope: OperationScope | undefined, chapter: number) { return !scope || scopesConflict(scope, { chapters: [chapter] }); }
export function jobOperationScope(type: string, payload: unknown): OperationScope {
  const input = payload && typeof payload === "object" ? payload as Record<string, any> : {};
  const resources: string[] = [];
  const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
  const target = input.target ?? input;
  let scope: OperationScope | undefined;
  if (positive(target.chapter)) scope = { chapters: [target.chapter] };
  else if (Array.isArray(input.selections) && input.selections.length && input.selections.every((row: any) => positive(row.chapter))) scope = { chapters: [...new Set<number>(input.selections.map((row: any) => row.chapter))] };
  else if (Array.isArray(input.chapters) && input.chapters.length && input.chapters.every(positive)) scope = { chapters: [...new Set<number>(input.chapters)] };
  else if (positive(input.from) || positive(input.to)) scope = { from: positive(input.from) ? input.from : 1, to: positive(input.to) ? input.to : undefined };
  else if (typeof target.summaryId === "string") scope = { resources: [`summary:${target.summaryId}`] };
  if (!scope) return type === "voicePreview" ? { resources: [] } : { all: true };
  // Context writers share a cumulative Story Bible. Their chapter sequence must
  // remain ordered; independent media work can still run alongside them.
  const stages = input.stages ?? (input.stage ? [input.stage] : []);
  if (type === "production" || (type === "batch" && !input.stage) || stages.some((stage: string) => ["translation", "narration", "qa", "storyBible", "continuity"].includes(stage)) || (["batch", "stageExecution"].includes(type) && input.mode !== "selected")) resources.push("context");
  if (["audiobook", "videoExport"].includes(type)) resources.push(`export:${type}`);
  return { ...scope, resources: [...(scope.resources ?? []), ...resources] };
}
