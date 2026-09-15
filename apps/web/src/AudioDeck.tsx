import { useEffect, useRef, useState } from "react";

export function AudioDeck({ src, title, download = false, downloadUrl }: { src?: string; title: string; download?: boolean; downloadUrl?: string }) {
  const ref = useRef<HTMLAudioElement>(null); const [playing, setPlaying] = useState(false); const [error, setError] = useState("");
  useEffect(() => { setPlaying(false); setError(""); }, [src]);
  if (!src) return <div className="empty"><span className="empty-glyph">¶</span><h3>No audio master</h3><p>Audio becomes available after TTS completes.</p></div>;
  const toggle = async () => { try { setError(""); if (playing) ref.current?.pause(); else await ref.current?.play(); } catch { setError("Could not play this audio. Try downloading it or regenerating the audio."); } };
  return <div><div className="audio-deck"><button aria-label={playing ? `Pause ${title}` : `Play ${title}`} onClick={() => void toggle()}>{playing ? "Ⅱ" : "▶"}</button><div><b>{title}</b><div className="waveform" aria-hidden="true">{Array.from({ length: 42 }, (_, i) => <i style={{ height: `${18 + (i * 17 % 32)}%` }} key={i} />)}</div></div>{download && <a className="audio-download" href={downloadUrl ?? src} download>Download MP3</a>}<audio ref={ref} src={src} preload="metadata" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setPlaying(false); setError("Audio could not be loaded. Try downloading it or regenerating the audio."); }} /></div>{error && <p className="error-box" role="alert">{error}</p>}</div>;
}
