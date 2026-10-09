import { pathToFileURL } from "node:url";
import { z } from "zod";
import { loadEnvironment, resolveStudioRoot } from "../../src/config/env.js";
import { parseChapterSelection } from "../../src/batch/range.js";
import { agentStageSchema, prepareAgentRun, confirmAgentRun, nextAgentRequest, submitAgentResponse, failAgentRequest, resumeAgentRun, reportAgentRun } from "../../src/agent-processing/service.js";

const help = `Subscription agent processing (local only; no paid provider fallback)
  prepare --story SLUG --chapters "1,5-10,78,100-150" --stages translation,narration --agent codex|antigravity --model MODEL [--image-model MODEL] [--force] [--stop-on-error]
  confirm --story SLUG --run UUID --plan FINGERPRINT
  next|resume|report --story SLUG --run UUID
  respond --story SLUG --run UUID --request REQUEST_ID --file LOCAL_FILE
  fail --story SLUG --run UUID --request REQUEST_ID --outcome refused|failed|needs-input --reason MESSAGE
Run through npm run story:agent -- <command>. Confirm only after the user approves the preview.
Text responses are UTF-8; structured responses are raw JSON; image responses are PNG.
Use the agent's current session model or 'unknown'; never substitute the app's configured API model.`;
export async function runAgentCommand(args: string[], root: string) {
  const [command, ...rest] = args;
  if (!command || command === "--help" || command === "help") return { help };
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index]!;
    if (!name.startsWith("--") || name in flags) throw new Error(`Invalid or duplicate option: ${name}`);
    if (name === "--force" || name === "--stop-on-error") flags[name] = true;
    else { const value = rest[++index]; if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`); flags[name] = value; }
  }
  const allowed: Record<string, string[]> = {
    prepare: ["story", "chapters", "stages", "agent", "model", "image-model", "force", "stop-on-error"],
    confirm: ["story", "run", "plan"], next: ["story", "run"], resume: ["story", "run"], report: ["story", "run"],
    respond: ["story", "run", "request", "file"], fail: ["story", "run", "request", "outcome", "reason"],
  };
  if (!allowed[command]) throw new Error(help);
  for (const name of Object.keys(flags)) if (!allowed[command]!.includes(name.slice(2))) throw new Error(`Unknown option: ${name}`);
  const required = (name: string) => z.string().min(1).parse(flags[`--${name}`]);
  const story = required("story");
  if (command === "prepare") return prepareAgentRun(root, {
    story, chapters: parseChapterSelection(required("chapters")), stages: required("stages").split(",").map((stage) => agentStageSchema.parse(stage.trim())),
    agent: required("agent"), model: required("model"), imageModel: flags["--image-model"] ?? "unknown", force: Boolean(flags["--force"]), continueOnError: !flags["--stop-on-error"],
  });
  const id = required("run");
  if (command === "confirm") return confirmAgentRun(root, story, id, required("plan"));
  if (command === "respond") return submitAgentResponse(root, story, id, required("request"), required("file"));
  if (command === "fail") return failAgentRequest(root, story, id, required("request"), z.enum(["refused", "failed", "needs-input"]).parse(required("outcome")), required("reason"));
  if (command === "resume") return resumeAgentRun(root, story, id);
  if (command === "next") return nextAgentRequest(root, story, id);
  return reportAgentRun(root, story, id);
}
async function main() {
  const started = Date.now();
  const command = process.argv[2] ?? "help";
  // Keep stdout reserved for the final JSON result. A yielded host command is
  // still running until its terminal task reports an exit code.
  const heartbeat = setInterval(() => {
    process.stderr.write(`${JSON.stringify({ progress: "running", command, elapsedSeconds: Math.floor((Date.now() - started) / 1000), instruction: "Wait for this command to exit; do not resubmit or start a second command for this run." })}\n`);
  }, 15_000);
  heartbeat.unref();
  try {
    const result = await runAgentCommand(process.argv.slice(2), resolveStudioRoot(loadEnvironment()));
    const run = "status" in result ? result as { status: string; request?: unknown } : undefined;
    const nextAction = run?.status === "complete" ? "Report the completed batch."
      : run?.status === "awaiting-confirmation" ? "Show the preview and wait for user confirmation."
      : run?.status === "needs-input" ? "Explain the diagnostic and required user input."
      : run?.request ? "Generate and submit the returned request; continue the confirmed batch without ending the turn."
      : run ? "Run next for this existing run; continue until complete or blocked." : undefined;
    process.stdout.write(`${JSON.stringify({ ...result, ...(nextAction ? { runner: { commandFinished: true, nextAction } } : {}) }, null, 2)}\n`);
  } finally { clearInterval(heartbeat); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error instanceof Error ? error.message : String(error), apiRequests: 0 })}\n`);
  process.exitCode = 1;
});
