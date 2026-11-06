import { describe, expect, it } from 'vitest';
import { applyNarrationNamingPreferences, narrationNameRequirements } from '../src/narration/naming-preferences.js';
import { authorizedNarrationNaming } from '../src/qa/prompts.js';
import { canonicalEntitySchema } from '../src/domain/story-bible.js';
import { needsContextualNameResolution } from '../src/narration/name-scope.js';

describe('identity-scoped narration names', () => {
  const tiger = { canonicalName: 'Tiger', preferredNarrationName: 'Yin Tiger', aliases: [] };
  it('does not rewrite a one-word character name inside a guild or skill, including unlisted names', () => {
    const text = 'Sword Tiger Guild used Tiger’s Might and Tiger Frenzy. A tiger watched. Tiger spoke.';
    expect(applyNarrationNamingPreferences(text, { canonicalEntities: [tiger] })).toBe(text);
    expect(applyNarrationNamingPreferences('Yin Tiger spoke.', { canonicalEntities: [tiger] })).toBe('Yin Tiger spoke.');
  });
  it('does not turn ordinary animals into the named character, even at sentence starts', () => {
    const context = {canonicalEntities:[{ canonicalName:'Dog', aliases:['hound'], preferredNarrationName:'Rex', aliasNarrationRules:[{alias:'hound',behavior:'custom',replacement:'Rex'}]}]};
    const text='A dog chased another dog. Dog tracks covered the road. The hound barked.';
    expect(applyNarrationNamingPreferences(text,context)).toBe(text);
  });
  it('leaves ambiguous rat aliases to context while preserving an already resolved identity', () => {
    const rat = { canonicalName: 'Zi-Shu', aliases: ['Rat', 'Zi-Rat'], preferredNarrationName: 'Zi Rat' };
    const text = 'A rat ran past Rat King Hall. Rat poison lay nearby. Rat answered Tiger. Zi Rat nodded.';
    expect(applyNarrationNamingPreferences(text, { canonicalEntities: [rat, tiger] })).toBe(text);
    const guidance = narrationNameRequirements({ canonicalEntities: [rat, tiger] });
    expect(guidance).toContain('only when that referent is clear');
    expect(guidance).toContain('do not suppress a legitimate short-name reference');
  });
  it('protects a longer identity with no override, even when the explicit naming roster omits it', () => {
    const dragon={canonicalName:'Black Dragon',aliases:[],preferredNarrationName:'Umbra'};
    const context={narrationNamingEntities:[dragon],canonicalEntities:[dragon,{canonicalName:'Black Dragon Guild',aliases:['Black Dragon Hall']}]};
    expect(applyNarrationNamingPreferences("Black Dragon's wings covered Black Dragon Guild. Black Dragon Hall waited.",context))
      .toBe("Umbra's wings covered Black Dragon Guild. Black Dragon Hall waited.");
  });
  it('applies a full guild override once without cascading into its shorter character name', () => {
    const context={canonicalEntities:[tiger,{canonicalName:'Sword Tiger Guild',aliases:[],preferredNarrationName:'Saber Tiger Guild'}]};
    const output=applyNarrationNamingPreferences('Sword Tiger Guild arrived.',context);
    expect(output).toBe('Saber Tiger Guild arrived.');
    expect(applyNarrationNamingPreferences(output,context)).toBe(output);
  });
  it('preserves a shared multiword alias owned by an entity without an override', () => {
    const context={canonicalEntities:[{canonicalName:'Ghost King',aliases:['Dark King'],preferredNarrationName:'Tarkatan'},{canonicalName:'Dark King',aliases:[]}]};
    expect(applyNarrationNamingPreferences('Dark King met Ghost King.',context)).toBe('Dark King met Tarkatan.');
  });
  it('keeps context checks in generation and QA guidance without changing the authorized mapping', () => {
    const entity=canonicalEntitySchema.parse({id:'ent_aaaaaaaaaaaaaaaaaaaaaaaa',type:'character',...tiger,firstAppearance:1,lastKnownAppearance:1});
    for(const guidance of [narrationNameRequirements({canonicalEntities:[entity]}),authorizedNarrationNaming([entity])]){
      expect(guidance).toContain('Sword Tiger Guild');expect(guidance).toContain('a dog');expect(guidance).toContain('capitalization alone');
    }
    expect(needsContextualNameResolution('Feixue')).toBe(true);
    expect(needsContextualNameResolution('Su Ming')).toBe(false);
  });
});
