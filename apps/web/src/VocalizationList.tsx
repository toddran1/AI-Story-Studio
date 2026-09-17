export function VocalizationList({ transformations }: { transformations?: Array<{ kind: string; written: string; spoken: string }> }) {
  const vocalizations = (transformations ?? []).filter((item) => item.kind === "vocalization");
  if (!vocalizations.length) return null;
  return <div className="vocalization-list"><b>Vocalizations</b><ul>{vocalizations.map((item, index) => <li key={index}><span className="mono">{item.written}</span><span aria-hidden="true">→</span><span className="mono">{item.spoken || "omitted"}</span></li>)}</ul></div>;
}
