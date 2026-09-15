export const LANGUAGE_OPTIONS = [
  ["zh-CN", "Chinese · Simplified"],
  ["en-US", "English"],
  ["es-ES", "Spanish"],
  ["fr-FR", "French"],
  ["de-DE", "German"],
  ["ja-JP", "Japanese"],
  ["ko-KR", "Korean"],
  ["pt-BR", "Portuguese · Brazil"],
  ["it-IT", "Italian"],
  ["ru-RU", "Russian"],
  ["ar-SA", "Arabic"],
] as const;

export function LanguageSelect({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const known = LANGUAGE_OPTIONS.some(([code]) => code === value);
  return <select value={value} onChange={(event) => onChange(event.target.value)}>{!known && <option value={value}>{value ? `${value} · Existing value` : "Infer automatically"}</option>}{LANGUAGE_OPTIONS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}</select>;
}

export function defaultLocale(language?: string) {
  const value = language?.trim();
  if (value && LANGUAGE_OPTIONS.some(([code]) => code === value)) return value;
  return ({ english: "en-US", chinese: "zh-CN", spanish: "es-ES", french: "fr-FR", german: "de-DE", japanese: "ja-JP", korean: "ko-KR", portuguese: "pt-BR", italian: "it-IT", russian: "ru-RU" } as Record<string, string>)[value?.toLocaleLowerCase() ?? ""] ?? "en-US";
}
