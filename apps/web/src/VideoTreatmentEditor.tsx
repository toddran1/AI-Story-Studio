import type { Scene } from "../../../src/scenes/types.js";
import { cleanVideoTreatment } from "./VideoTimelineEditor.js";

type Treatment = NonNullable<Scene["videoTreatment"]>;
const motionChoices = [["story_default", "Story default"], ["auto_subtle", "Auto subtle"], ["still", "Still"], ["zoom_in", "Zoom in"], ["zoom_out", "Zoom out"], ["pan_left", "Pan left"], ["pan_right", "Pan right"], ["pan_up", "Pan up"], ["pan_down", "Pan down"]] as const;
const transitionChoices = [["story_default", "Story default"], ["cut", "Cut"], ["dissolve", "Dissolve"], ["fade_black", "Fade through black"], ["slide", "Slide"]] as const;

export function VideoTreatmentEditor({ scene, hasNext, disabled, onChange }: { scene: Scene; hasNext: boolean; disabled?: boolean; onChange: (value: Treatment | undefined) => void }) {
  const treatment = scene.videoTreatment ?? {};
  return <details className="video-treatment-editor"><summary>Video treatment</summary><div className="video-treatment-fields">
    <label>Motion<select disabled={disabled} value={treatment.motion ?? "story_default"} onChange={(event) => onChange(cleanVideoTreatment({ ...treatment, motion: event.target.value as Treatment["motion"] }))}>{motionChoices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>Transition to next scene<select disabled={disabled || !hasNext} value={hasNext ? treatment.transitionOut?.mode ?? "story_default" : "story_default"} onChange={(event) => onChange(cleanVideoTreatment({ ...treatment, transitionOut: { ...treatment.transitionOut, mode: event.target.value as NonNullable<Treatment["transitionOut"]>["mode"] } }))}>{transitionChoices.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>Duration override · seconds<input disabled={disabled || !hasNext} type="number" min="0" max="2" step="0.05" placeholder="Story default" value={hasNext ? treatment.transitionOut?.durationSeconds ?? "" : ""} onChange={(event) => onChange(cleanVideoTreatment({ ...treatment, transitionOut: { ...treatment.transitionOut, durationSeconds: event.target.value === "" ? undefined : Math.min(2, Math.max(0, Number(event.target.value))) } }))} /></label>
  </div>{!hasNext && <small>The final enabled scene has no outgoing transition.</small>}</details>;
}
