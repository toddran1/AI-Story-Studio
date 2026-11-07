import { useState } from "react";
import type { Scene } from "./api.js";
import { previewVisuals, referenceUrl, type ResolvedVisualPreview } from "./visual-workflow.js";
export function SceneVisualPreview({ slug, scene, chapter, summaryId }: { slug: string; scene: Scene; chapter?: number; summaryId?: string }) {
  const [preview, setPreview] = useState<ResolvedVisualPreview>(); const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [snapshot, setSnapshot] = useState("");
  const current = JSON.stringify({ scene, chapter });
  return <details><summary>Visual references and generation preview</summary><p>Preview the current scene draft before generating. This does not create images or save edits. Generation also adds scene continuity.</p><button type="button" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { setPreview(await previewVisuals(slug, scene, chapter, summaryId)); setSnapshot(current); } catch (error) { setPreview(undefined); setError(String(error)); } finally { setBusy(false); } }}>{busy ? "Resolving…" : "Preview visual choices"}</button>
    {error && <p role="alert">{error}</p>}{preview && <div>{snapshot !== current && <p role="status">Scene changed. Refresh this preview.</p>}{Boolean(preview.continuityIssues?.length) && <section><h4>Continuity preflight</h4><ul>{preview.continuityIssues?.map(issue => <li key={issue}>{issue}</li>)}</ul></section>}{preview.continuityReview && <ContinuityReview review={preview.continuityReview} />}{preview.resolvedEntities.map((entity, index) => <div key={`${entity.entityId}:${index}`}><strong>{entity.name}</strong><p>{entity.appearanceEra?.name ?? entity.groundingMode.replaceAll("_", " ")}</p><p>{entity.description}</p>{entity.references?.filter(ref => preview.references.loadedReferences.some(loaded => loaded.entityId === entity.entityId && loaded.referenceId === ref.id)).map(ref => <img key={ref.id} width="100" alt={`Reference for ${entity.name}`} src={referenceUrl(slug, entity.entityId, ref.id)} />)}</div>)}<details><summary>Resolved identity and design prompt</summary><pre style={{ whiteSpace: "pre-wrap" }}>{preview.prompt}</pre><p>{preview.negativePrompt}</p></details><p>{preview.references.loadedReferenceIds.length} of {preview.references.available} eligible references loaded · {preview.references.mode}. Missing files and provider limits may reduce the references sent.</p></div>}
  </details>;
}

function ContinuityReview({ review }: { review: NonNullable<ResolvedVisualPreview["continuityReview"]> }) {
  return <>
    {review.artworkBaselineMissing && <p>This artwork predates continuity snapshots. A before-and-after comparison is unavailable.</p>}
    {([
      ["Scene plan needs review", review.sceneChanges],
      ["Artwork needs review", review.artworkChanges],
    ] as const).map(([title, changes]) => changes.length > 0 && <section key={title}>
      <h4>{title}</h4>
      <dl>{changes.map(({ detail, before, after }) => <div key={detail}>
        <dt>{detail}</dt>
        <dd><del>{before ?? "Unset"}</del> → <ins>{after ?? "Unset"}</ins></dd>
      </div>)}</dl>
    </section>)}
  </>;
}
