# Creature templates, forms, and scene groups

Use **One identifiable creature** for a recurring individual such as a named dragon. Its approved appearance eras apply by chapter, including a lasting transformation into a bone dragon. Scene groups reuse a compatible approved era rather than requiring a duplicate form. An era's creature-state control distinguishes living, dead, zombie, skeleton, undead, and other appearances.

Use **Species / interchangeable creatures** for a shared goblin design. A template has reusable **Creature forms** instead of a species-wide appearance timeline. Living, corpse, zombie, and skeletal forms can coexist in one scene. A single goblin's death must not change every goblin in subsequent chapters.

Scene planning proposes **Creature groups and forms** from the current narration. Each group records a canonical creature identity, label, state, optional exact count, and source excerpt. Unsupported excerpts, duplicate group IDs, and unresolved creature identities are rejected or removed at the planning boundary. Unspecified counts remain unspecified. Existing saved scenes do not acquire inferred groups without replanning or an editorial group edit.

Planning and scene edits prepare draft forms without generating images. Open the creature's Visual Profile, review the proposed form, and use **Save and generate form reference sheet**. Review the candidate and choose **Approve sheet, form and profile**. This approval is saved atomically. Approved forms can also use uploaded references, or be approved with a written appearance only. Image generation uses the book's configured artwork provider and model.

Each scene group uses only its selected form's references. Incompatible anatomy from the template is excluded when a form supplies a complete appearance. The artwork preflight requests review for missing or draft forms. Its explicit fallback choices remain available; fallback rendering uses the narrated group state, never unapproved form details. If multiple approved forms share a state, enter the desired form ID in the scene group editor.

Group edits participate in scene and artwork fingerprints. Single-scene saves preserve them; prompt-only regeneration keeps their assignments. Approved references remain scoped to their form, and form references survive canonical entity merges. Conflicting merged forms return to draft review instead of silently selecting a design.

Death, undeath, and skeletal transformation are separate states. Neither death alone nor temporary injuries justify an undead or skeletal appearance. Scene planning remains an AI interpretation and its proposals and final artwork should be reviewed.

## Visual review and scene previews

The Story Bible now includes a **Visual review queue** for draft profiles, missing approved references, pending eras/forms, and unresolved conflicts. Search by entity or design. A form or era sheet can be selected after reviewing its thumbnail and appearance; **Approve selected reviewed sheets and designs** processes the selection sequentially and reports failures without discarding successful approvals. Era approval, reference approval, and chapter-boundary adjustments save atomically.

Chapter and summary scene editors offer canonical creature-name suggestions and an approved-design selector. Selecting a canonical name records its stable entity ID. Each group displays its approved form references. **Visual references and generation preview** resolves the current scene draft through the artwork resolver without saving edits or generating images. It reports loaded identity references, including provider limitations and missing files. Summary previews respect summary/scene art-direction overrides. Scene continuity and continuity images are added by actual artwork generation, so this is an identity/design preview rather than a complete image request.

Visual Profiles include **Scenes affected by visual changes**, a conservative inventory of chapter and summary scene usage. Approved and manually edited artwork is marked protected; the inventory itself never changes artwork.

Automatically detected eras record a fingerprint of their source evidence. Automatically prepared forms track the scene evidence in their originating chapter or summary. If that evidence changes or disappears, the design is retained and flagged for re-review. Existing generated/approved artwork is preserved. Review the new source, edit/remove the design, or explicitly keep it as an editorial design and save. That editorial decision removes automatic source tracking for the retained design.

## Batch generation and selective updates

In the visual review queue, select the profiles, eras, or forms that need sheets and use **Preview generation**. The plan shows which sheets will be reused, which designs need review, identity-image support, and an estimated output-image cost from the studio's pricing catalog. Actual usage can differ. Start the batch after reviewing the plan. Generated sheets remain candidates for approval. Stop requests finish the current provider request before stopping; interrupted jobs restore as paused. **Preview remaining work** prepares a new plan and avoids repeating completed entries. Requesting fresh candidates explicitly regenerates selected sheets.

Era/form sheets use an approved identity image when the configured image model supports it. Compatible identity features carry forward, while the target era/form replaces old anatomy. The sheet records whether generation used an image or text only and explains any fallback. This improves consistency but does not guarantee it.

In **Scenes affected by visual changes**, select only the scenes you want to update, preview the cost, and generate replacement candidates. Approved and manually edited scenes require explicit inclusion. Their approved artwork remains active until you approve a new version. Changing visual inputs after preview requires another preview before generation.

## Optional artwork checks

Chapter and summary artwork versions offer an optional **AI visual check** using the book's configured QA provider/model. It checks identity, creature state, explicit counts, signature features, and composition against the current resolved design and available approved references. OpenAI and Gemini adapters accept local image inputs; the selected QA model must support vision. The Kimi text adapter rejects these requests before sending them.

Checks are advisory and never approve, reject, or regenerate artwork. They may be uncertain or incorrect, especially for occluded features or crowds. Running a check can incur provider usage. Saved results are reused while their artwork, visual targets, references, and QA configuration match; changes mark the result stale. Image inputs are bounded and read only from controlled story artifact paths.
