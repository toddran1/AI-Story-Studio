type FilmstripScene = {
  id: string;
  summary: string;
  startSeconds: number;
  endSeconds: number;
  importance?: string;
  disabled?: boolean;
  artwork?: { review?: string };
};

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;

/** Source-neutral timing overview. Callers supply source-specific image/status links. */
export function SceneFilmstrip<T extends FilmstripScene>({ scenes, imageFor, statusFor, onSelect }: {
  scenes: T[];
  imageFor?: (scene: T) => string | undefined;
  statusFor?: (scene: T) => string;
  onSelect: (scene: T) => void;
}) {
  return <div className="filmstrip" aria-label="Scene timing preview">
    {scenes.map((scene) => {
      const image = imageFor?.(scene);
      return <button key={scene.id} type="button"
        style={{ flexGrow: Math.max(1, scene.endSeconds - scene.startSeconds), opacity: scene.disabled ? .45 : 1 }}
        className={`${scene.importance ?? "standard"} ${scene.artwork?.review ?? "unreviewed"}`}
        title={`${scene.id}: ${statusFor?.(scene) ?? (scene.disabled ? "Disabled" : "Planned")}`}
        onClick={() => onSelect(scene)}>
        <i />{image ? <img src={image} alt="" /> : <span>{scene.id.replace("scene-", "")}</span>}
        <small>{time(scene.startSeconds)}–{time(scene.endSeconds)}</small>
      </button>;
    })}
  </div>;
}
