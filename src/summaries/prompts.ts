import type { SummaryType } from "./types.js";

export const SUMMARY_PROMPT_VERSION = "1";

const styles: Record<SummaryType, string> = {
  brief: "Write a concise recap centered on the essential events, outcomes, and reveals.",
  detailed: "Write a detailed readable recap preserving important events, motivations, relationships, stakes, reveals, and outcomes.",
  "mini-chapter": "Write a smooth condensed narrative that reads like a short chapter, with coherent transitions and selective dialogue—not bullets or an outline.",
  arc: "Explain the arc as a cohesive progression: setup, escalation, turning points, climax, outcome, and unresolved threads.",
  "character-focused": "Center the recap on the requested character or focus, including motivations, decisions, relationships, development, and consequences.",
  custom: "Follow the supplied focus and instructions while producing a faithful readable retelling.",
};

export function summaryInstructions(type: SummaryType, targetWords: number, outputLanguage: string, focus?: string, instructions?: string, combining = false) {
  return `Create a faithful story summary. This answers “What happened in these chapters?” It is not Story Bible extraction and must not present a canonical fact database. ${styles[type]}

Preserve important plot events, causal order, motivations, relationships, reveals, stakes, outcomes, and continuity. Do not invent events or use outside knowledge. Preserve chapter chronology even when the selected chapters are non-contiguous; acknowledge jumps naturally without pretending omitted chapters were supplied. Return prose only with no preface, process notes, or markdown fence.

Write the recap in ${outputLanguage}. Aim for approximately ${targetWords} words.${focus ? ` FOCUS: ${focus}` : ""}${instructions ? ` ADDITIONAL INSTRUCTIONS: ${instructions}` : ""}${combining ? " The input contains faithful intermediate recaps. Combine them without dropping their chapter coverage or duplicating events." : ""}`;
}
