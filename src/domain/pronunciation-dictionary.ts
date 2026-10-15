import { z } from "zod";

const arpabet = new Set("AA AE AH AO AW AY B CH D DH EH ER EY F G HH IH IY JH K L M N NG OW OY P R S SH T TH UH UW V W Y Z ZH".split(" "));
export const pronunciationRuleSchema = z.object({
  text: z.string().trim().min(1).max(256).regex(/^[^<>\[\]\r\n]+$/, "Enter a word or name, without control tags"),
  alphabet: z.enum(["pinyin", "arpabet"]),
  phonemes: z.string().trim().min(1).max(1024),
}).strict().superRefine((rule, ctx) => {
  const tokens = rule.phonemes.split(/\s+/);
  const valid = rule.alphabet === "pinyin" ? tokens.every(token => /^[a-züv:]+[1-5]$/u.test(token)) : tokens.every(token => /^[A-Z]+[012]?$/.test(token) && arpabet.has(token.replace(/[012]$/, "")));
  if (!valid) ctx.addIssue({ code: "custom", path: ["phonemes"], message: rule.alphabet === "pinyin" ? "Use tone-number pinyin, such as zhang1 qi3 tian1" : "Use CMU Arpabet, such as JH AA1 NG" });
});
export const pronunciationDictionarySchema = z.array(pronunciationRuleSchema).max(5000).superRefine((rules, ctx) => {
  const seen = new Set<string>();
  rules.forEach((rule, index) => { const key = rule.text.toLowerCase(); if (seen.has(key)) ctx.addIssue({ code: "custom", path: [index, "text"], message: "Each dictionary word or name must be unique" }); seen.add(key); });
});
export type PronunciationRule = z.infer<typeof pronunciationRuleSchema>;
