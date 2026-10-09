# Subscription agent processing

The project skill `story-studio` lets a signed-in Codex or Antigravity agent generate chapter outputs itself and import them using the same application services as API processing. The bridge never constructs OpenAI, Gemini, Kimi, or Fish API adapters. It makes no paid provider requests, including when a stage fails. The host agent still consumes its own subscription quota/credits; the bridge cannot verify account authentication or measure subscription billing.

The shared skill is at `.agents/skills/story-studio/SKILL.md`. Current Codex and Antigravity releases discover project skills there. Reload the project/chat if it does not appear. For older Antigravity installations, use the skill location supported by that installed version. No global installation or account secrets are required.

## Prompt workflow

For example, in a Codex chat opened in this project:

> Use $story-studio for undead-disaster, chapters 1, 5-10, 78, 100-150. Do translation and narration. Continue after chapter failures.

In Antigravity, invoke `story-studio` by name or use its skill picker/slash command where supported. The same skill and local commands work with both hosts.

The first response previews the selection, stages, model, reuse/regeneration, and missing prerequisites. It waits for explicit confirmation before executing. If the agent cannot see the actual session model, the preview and persisted provenance say `unknown`; the story's configured API model is not substituted. The image model is tracked separately. Confirming a preview does not authorize automatic paid API fallback.

After confirmation, the agent reads the app-generated request, writes a complete text/JSON result or uses its native image-generation tool, and submits the output. The bridge validates and commits each stage. Results appear in the existing studio views and ordinary filesystem artifacts; Postgres remains queue coordination only. Successful subscription results are marked accepted for normal pipeline reuse, with actual reported model and `execution.source = subscription-agent`, run ID, host, and zero API requests. No subscription token counts or dollar costs are fabricated.

Supported stages:

| Name | Output / prerequisites |
| --- | --- |
| `translation` | Complete English chapter from a retained/imported original; local ingestion is included |
| `narration` | Clean narration and provider-directed narration script; requires translation |
| `qa` | Stateful QA findings and summary; requires original and narration |
| `storyBible` | Structured update, cumulative canonical Bible, and derived context; requires narration and QA |
| `continuity` | Existing deterministic local analysis/review state; requires Story Bible/context |
| `scenePlanning` | Scene manifest and visual continuity; requires narration, context, mastered audio |
| `artwork` | PNG assets, versions, fingerprints, and unreviewed artwork records; requires scenes and any visual-profile prerequisites |

Spoken audio, mastering, subtitles, and video are not selectable here. Existing mastered audio is reusable for scenes. Missing prerequisites are reported; no unrequested AI stage or paid TTS is generated. Existing complete artifacts are reused by default when their recorded output fingerprints match; request regeneration to use `--force`.

QA uses the existing full stateful recheck path, including deterministic checks, approved exceptions, prior findings, dismissals, and resolution history. A successfully executed evaluation can have `warn` or `fail` quality; both are saved. Critical findings block downstream work but do not stop batch QA. This path never invokes the normal pipeline's automatic translation/narration regeneration.

## Local commands

All commands emit JSON. Run `npm run story:agent -- --help` for arguments.

```sh
npm run story:agent -- prepare --story undead-disaster --chapters '1,5-10,78,100-150' --stages translation,narration --agent codex --model unknown
```

Save the returned run ID and plan fingerprint. **Only after the user confirms:**

```sh
npm run story:agent -- confirm --story undead-disaster --run RUN_UUID --plan PLAN_FINGERPRINT
npm run story:agent -- next --story undead-disaster --run RUN_UUID
```

The response's `request` contains the app's instructions/input, JSON Schema for structured stages, or image prompt and local reference paths. Its `configuredModel` is informational API configuration. Generate using the current signed-in agent, not that model's API.

```sh
npm run story:agent -- respond --story undead-disaster --run RUN_UUID --request REQUEST_ID --file /absolute/path/response.txt
```

Use raw UTF-8 for text, raw JSON for structured output, and PNG for native image output. Responses must be nonempty and at most 32 MiB. Reference images are exported locally under the private run directory. Native image tools must be available in the host; if a usable local asset cannot be obtained, pause rather than call a paid image API.

Each response advances until another agent request, required input, or completion. Multiple image requests can be needed for one chapter. A stage is committed after all of its required responses validate; previous valid artifacts survive a failed attempt.

```sh
npm run story:agent -- fail --story undead-disaster --run RUN_UUID --request REQUEST_ID --outcome refused --reason 'The model refused to translate and offered a summary'
npm run story:agent -- report --story undead-disaster --run RUN_UUID
npm run story:agent -- resume --story undead-disaster --run RUN_UUID
```

Other failure outcomes are `failed` and `needs-input`. Refusals and recognized refusal/summary substitutions skip dependent stages and normally continue with eligible chapters. Add `--stop-on-error` to prepare when the batch should pause on any failure. Invalid structured responses pause and can be corrected and resubmitted. Content-fidelity checks cannot perfectly detect every disguised summary; the skill requires full translations, and QA checks omissions.

The saved run lists each chapter/stage outcome, reason, QA quality, model provenance, and known context gaps. The agent's final answer lists refused/summary-substituted chapters separately. Story Bible and continuity updates block across known earlier selected context gaps; unrelated eligible translation/narration/QA can continue. Failed attempts also record `lastAgentAttempt` in existing chapter metadata without replacing a valid completed stage.

## Persistence and interruption

Runs live in ignored `stories/<slug>/agent-runs/<uuid>/run.json`; outputs remain in ordinary chapter/story files. The run manifest is resumable from another chat. Do not commit run data, prompts, response files, or private chapter content.

Preparation writes only the run preview. Execution replays the existing stage services against an isolated copy of the story, with local-only response providers. Only a completed, validated stage's delta is committed under the per-story lock. Source and story fingerprints are checked before processing and before publishing. Manual edits made during a pause require a new preview/confirmation; completed work stays saved.

Commits keep exact prior bytes in a durable rollback journal and publish chapter metadata after its artifacts. The stage checkpoint is committed in the same recoverable operation. The next processing command rolls back an unfinished transaction before continuing; a journal already marked committed only needs cleanup. Recovery checks for edits made after interruption and pauses instead of overwriting those edits. If persistence/rollback fails, the command stops; recover that issue before further processing.

Text-only runs snapshot selected chapters' direct text/JSON artifacts, retained imported sources, story configuration/manual overlays, eligible summary records, and chronological chapter metadata/Bible evidence. They skip unrelated chapter text, audio, images, TTS working directories, and media backups entirely. Input hashing and snapshot copying use bounded concurrency. Every included input is still hashed on each check; changes to relevant content during a pause still stop publication. Unrelated media edits do not invalidate a text run, and those files are never deleted or overwritten by its commits.

Scene planning/artwork runs retain the full content/media snapshot for reference and prerequisite compatibility. Copy-on-write is used where supported. Runs, production logs, batches, exports, previews, and locks are excluded. Symbolic links in processing inputs are rejected. Older saved runs verify their original full inventory once, then save the new inventory mode without changing their approval, pending request, or completed stages; this first upgrade and cleanup of an old large snapshot may still take time.

Commands write a running heartbeat to stderr every 15 seconds and reserve stdout for final JSON, including `runner.nextAction`. A host terminal task ID means the command is still running: the agent must wait/poll that same task until it exits, consume the final result, and continue the confirmed request loop. It should not finish its reply merely because a command yielded. The skill makes this explicit for both hosts. Instructions cannot override host turn limits, quota, or required permissions; if interrupted, continue the existing task/run rather than creating another run or resubmitting a response.

Validation uses mocked text/JSON/image outputs; no paid APIs or real subscription generation are used in tests.
