/**
 * 🖥️ Desktop Vision & Process Grounding Agent
 * Executes genuine macOS screencapture and System Events process enumeration.
 *
 * Vision-language description of the captured screen is obtained from a REAL local
 * Ollama call (model "moondream", a real vision-capable model) when an Ollama server
 * is reachable on localhost:11434. If Ollama is not running or the model is not pulled,
 * this is reported honestly (no fabricated description, no fake success).
 *
 * NOTE ON HONESTY: this agent does NOT compute pixel click coordinates or bounding
 * boxes. Earlier versions of this project claimed "97.4% pixel-coordinate grounding"
 * and rendered fake bounding boxes on the UI; that was never backed by any model
 * output and has been removed. What IS real: process enumeration via System Events,
 * screen capture via /usr/sbin/screencapture, and (optionally) a natural-language
 * scene description from a local vision-language model.
 */

import { existsSync } from "fs";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const VISION_MODEL = process.env.OMNIOS_VISION_MODEL || "moondream";
const PLANNING_MODEL = process.env.OMNIOS_PLANNING_MODEL || "llama3.2:3b";

// Backend selection, previously nonexistent here: every LLM call in this
// file went straight to the OLLAMA_URL module constant with no indirection
// at all. LLM_BACKEND=localai (default stays "ollama", unchanged) routes
// the same two calls through a local LocalAI (github.com/mudler/LocalAI)
// instance instead, via LOCALAI_URL (default http://localhost:8080).
function currentLLMBackend(): "ollama" | "localai" {
  return (process.env.LLM_BACKEND || "ollama").trim().toLowerCase() === "localai" ? "localai" : "ollama";
}
const LOCALAI_URL = process.env.LOCALAI_URL || "http://localhost:8080";

export interface RealRunningProcess {
  id: string;
  name: string;
  isFrontmost: boolean;
  type: "application" | "system";
}

export interface PlannedStep {
  actionType: "activate_app" | "keystroke" | "notify" | "inspect_windows";
  target: string;
  textPayload?: string;
  reason: string;
}

export interface MultiStepPlanResult {
  goal: string;
  planningModelUsed: string | null;
  steps: PlannedStep[];
  rawModelOutput?: string;
  error?: string;
}

export interface OSActionPlan {
  goal: string;
  detectedFrontmostApp: string;
  realRunningProcesses: RealRunningProcess[];
  screenshotPath?: string;
  visionDescription?: string;
  visionModelUsed: string | null;
  actionType: "activate_app" | "keystroke" | "notify" | "inspect_windows";
  suggestedTarget: string;
  rationale: string;
}

export class VisionGroundingAgent {
  /**
   * Captures a real screenshot of the active display to disk. Defaults to
   * the fixed path the UI polls (`/api/pilot/screenshot-file`), but accepts
   * an explicit `outPath` so callers that need two genuinely distinct files
   * on disk at once - e.g. the before/after pair in the observe-act-verify
   * loop in server.ts's `runWithVerification` - don't have the "after"
   * capture silently overwrite the "before" capture at the same path before
   * it can be diffed (that was a real bug caught during manual testing:
   * both screenshots resolved to the same fixed file, so the pixel-diff
   * step always compared a file against itself and reported 0% changed).
   */
  public async captureScreen(outPath: string = "/tmp/omnios_live_capture.png"): Promise<string | null> {
    try {
      const proc = Bun.spawn(["/usr/sbin/screencapture", "-x", "-C", outPath]);
      await proc.exited;
      if (existsSync(outPath)) {
        return outPath;
      }
    } catch {}
    return null;
  }

  /**
   * Queries real visible running processes on macOS
   */
  public async getRealRunningProcesses(): Promise<{ frontmost: string; processes: RealRunningProcess[] }> {
    try {
      // NOTE: coercing an AppleScript list "as text" uses the CURRENT
      // "text item delimiters" (empty string by default), which silently
      // concatenates every process name with no separator at all
      // (e.g. "ChromeFinderTerminal..."). We must explicitly set the
      // delimiter to ", " before the coercion and restore it afterwards,
      // otherwise downstream `.split(", ")` never finds a match.
      const script = `
        tell application "System Events"
          set frontApp to name of first application process whose frontmost is true
          set appList to name of every application process whose visible is true
        end tell
        set oldDelims to AppleScript's text item delimiters
        set AppleScript's text item delimiters to ", "
        set appListText to appList as text
        set AppleScript's text item delimiters to oldDelims
        return frontApp & "|||" & appListText
      `;
      const proc = Bun.spawn(["osascript", "-e", script], { stdout: "pipe" });
      const out = await new Response(proc.stdout).text();
      const [frontmost, listStr] = out.trim().split("|||");

      const names = listStr ? listStr.split(", ") : ["Finder"];
      const processes: RealRunningProcess[] = names.map((name, idx) => ({
        id: `proc-${idx}`,
        name: name.trim(),
        isFrontmost: name.trim() === frontmost?.trim(),
        type: "application"
      }));

      return {
        frontmost: frontmost?.trim() || "Finder",
        processes
      };
    } catch {
      return {
        frontmost: "Finder",
        processes: [{ id: "proc-0", name: "Finder", isFrontmost: true, type: "application" }]
      };
    }
  }

  /**
   * Sends the real captured screenshot to a local vision-language model
   * (Ollama's native /api/generate with an `images` array, or - with
   * LLM_BACKEND=localai - a local LocalAI instance's OpenAI-compatible
   * /v1/chat/completions with an `image_url` content part, the format
   * OpenAI-vision-shaped APIs expect) and returns its genuine textual
   * description. Returns null (not a fabricated string) if the backend is
   * unreachable or the model call fails - callers must surface this
   * honestly instead of pretending grounding happened.
   */
  public async describeScreen(screenshotPath: string): Promise<{ description: string | null; model: string | null; error?: string }> {
    try {
      const file = Bun.file(screenshotPath);
      if (!(await file.exists())) {
        return { description: null, model: null, error: "screenshot file not found" };
      }
      const bytes = await file.arrayBuffer();
      const base64 = Buffer.from(bytes).toString("base64");

      if (currentLLMBackend() === "localai") {
        const res = await fetch(`${LOCALAI_URL}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: VISION_MODEL,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: "Describe concisely which application windows, menus and UI elements are visible on this desktop screenshot. Focus on anything relevant to automating a click or keystroke." },
                  { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } }
                ]
              }
            ],
            stream: false
          }),
          signal: AbortSignal.timeout(45000)
        });

        if (!res.ok) {
          return { description: null, model: VISION_MODEL, error: `LocalAI HTTP ${res.status}` };
        }
        const data: any = await res.json();
        const content = (data.choices?.[0]?.message?.content || "").trim();
        return { description: content || null, model: VISION_MODEL };
      }

      const res = await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: VISION_MODEL,
          prompt: "Describe concisely which application windows, menus and UI elements are visible on this desktop screenshot. Focus on anything relevant to automating a click or keystroke.",
          images: [base64],
          stream: false
        }),
        signal: AbortSignal.timeout(45000)
      });

      if (!res.ok) {
        return { description: null, model: VISION_MODEL, error: `Ollama HTTP ${res.status}` };
      }
      const data: any = await res.json();
      return { description: (data.response || "").trim() || null, model: VISION_MODEL };
    } catch (e: any) {
      // Backend not running, model not pulled, or timeout - be explicit, never fabricate.
      return { description: null, model: null, error: e.message || `${currentLLMBackend()} unreachable` };
    }
  }

  /**
   * Analyzes goal against genuine live desktop state: real frontmost app,
   * real visible process list, real screenshot, and (when available) a
   * real local vision-language model description of that screenshot.
   * The goal-to-action heuristic is a simple keyword match, not an ML
   * model - it is presented as such, not as "AI planning".
   */
  public async parseScreenAndPlan(goal: string): Promise<OSActionPlan> {
    const { frontmost, processes } = await this.getRealRunningProcesses();
    const screenshot = await this.captureScreen();
    const lower = goal.toLowerCase();

    let visionDescription: string | undefined;
    let visionModelUsed: string | null = null;
    if (screenshot) {
      const vision = await this.describeScreen(screenshot);
      if (vision.description) {
        visionDescription = vision.description;
        visionModelUsed = vision.model;
      } else {
        visionDescription = `Vision model unavailable (${vision.error || "unknown error"}); falling back to process-list heuristic only.`;
      }
    }

    let actionType: OSActionPlan["actionType"] = "inspect_windows";
    let target = frontmost;
    let rationale = `Active frontmost macOS app is ${frontmost}. Verified ${processes.length} visible running processes (keyword-based heuristic, no ML planning model involved in this step).`;

    if (lower.includes("apri") || lower.includes("open") || lower.includes("launch")) {
      actionType = "activate_app";
      const match = processes.find(p => lower.includes(p.name.toLowerCase()));
      target = match ? match.name : "Finder";
      rationale = `Keyword match found "open/apri" in goal. Targeting application "${target}" for activation via AppleScript "activate".`;
    } else if (lower.includes("scrivi") || lower.includes("type")) {
      actionType = "keystroke";
      target = frontmost;
      rationale = `Keyword match found "type/scrivi" in goal. Preparing keystroke stream to frontmost application: ${frontmost}.`;
    }

    return {
      goal,
      detectedFrontmostApp: frontmost,
      realRunningProcesses: processes,
      screenshotPath: screenshot || undefined,
      visionDescription,
      visionModelUsed,
      actionType,
      suggestedTarget: target,
      rationale
    };
  }

  /**
   * Real multi-step task planning: sends the goal and the genuine live
   * process list to a local Ollama text model (default llama3.2:3b, also
   * verified reachable on this machine: granite3-dense:2b / qwen2.5:7b) and
   * asks it to decompose the goal into a short ordered sequence of concrete
   * actions from OmniOS-Pilot's real action vocabulary (activate_app,
   * keystroke, notify, inspect_windows).
   *
   * HONESTY: this is a genuine LLM call, not a scripted template - the
   * model's response is parsed as JSON and used as-is. If Ollama is
   * unreachable, the model is not pulled, or the model's output cannot be
   * parsed as a valid step list, this returns an explicit `error` field and
   * an EMPTY steps array rather than silently falling back to a fabricated
   * plan. Inspired by the "planning" phase real GUI agents like UI-TARS-2
   * and self-operating-computer perform before the observe-act-verify loop.
   */
  public async planMultiStep(goal: string): Promise<MultiStepPlanResult> {
    const { frontmost, processes } = await this.getRealRunningProcesses();
    const processNames = processes.map((p) => p.name).join(", ");

    const prompt = `You are a macOS desktop automation planner. Decompose the user's goal into a short ordered JSON array of concrete steps.
Each step must be an object with exactly these fields:
  "actionType": one of "activate_app", "keystroke", "notify", "inspect_windows"
  "target": for activate_app, an app name (prefer one from the real running-processes list below if it fits, otherwise a real macOS app name like "TextEdit" or "Calculator"); for other action types, use the frontmost app name.
  "textPayload": text to type, ONLY when actionType is "keystroke" (omit otherwise)
  "reason": one short sentence explaining the step

Rules:
- Output ONLY a JSON array, no prose, no markdown fences.
- Use at most 5 steps.
- Never include destructive actions (no file deletion, no shell commands, no "sudo").
- Real frontmost app right now: ${frontmost}
- Real currently visible running apps: ${processNames}

User goal: "${goal}"`;

    // Measured on this machine: a cold Ollama model load alone can take
    // ~24s before the first token, plus prompt/eval time - a 45s budget
    // (originally copied from the vision-caption timeout) genuinely timed
    // out on a first real call during testing. 120s gives a cold load plus
    // this multi-sentence planning prompt real headroom.
    const planningTimeoutMs = 120000;
    const backend = currentLLMBackend();

    try {
      let raw: string;

      if (backend === "localai") {
        const res = await fetch(`${LOCALAI_URL}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: PLANNING_MODEL,
            messages: [{ role: "user", content: prompt }],
            temperature: 0.2,
            stream: false
          }),
          signal: AbortSignal.timeout(planningTimeoutMs)
        });
        if (!res.ok) {
          return { goal, planningModelUsed: null, steps: [], error: `LocalAI HTTP ${res.status}` };
        }
        const data: any = await res.json();
        raw = (data.choices?.[0]?.message?.content || "").trim();
      } else {
        const res = await fetch(`${OLLAMA_URL}/api/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: PLANNING_MODEL,
            prompt,
            stream: false,
            options: { temperature: 0.2 }
          }),
          signal: AbortSignal.timeout(planningTimeoutMs)
        });
        if (!res.ok) {
          return { goal, planningModelUsed: null, steps: [], error: `Ollama HTTP ${res.status}` };
        }
        const data: any = await res.json();
        raw = (data.response || "").trim();
      }

      // The model may wrap the array in prose or markdown fences despite
      // instructions - extract the first [...] block rather than assuming
      // the entire response is clean JSON.
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) {
        return { goal, planningModelUsed: PLANNING_MODEL, steps: [], rawModelOutput: raw, error: "Model output did not contain a parseable JSON array" };
      }

      let parsedSteps: any[];
      try {
        parsedSteps = JSON.parse(match[0]);
      } catch (e: any) {
        return { goal, planningModelUsed: PLANNING_MODEL, steps: [], rawModelOutput: raw, error: `JSON parse error: ${e.message}` };
      }

      const validActionTypes = new Set(["activate_app", "keystroke", "notify", "inspect_windows"]);
      const steps: PlannedStep[] = [];
      for (const s of parsedSteps.slice(0, 5)) {
        if (!s || typeof s !== "object") continue;
        if (!validActionTypes.has(s.actionType)) continue;
        // Hard safety net independent of SafetyGuard: never let a planned
        // step's text payload through if it smells destructive.
        const textPayload = typeof s.textPayload === "string" ? s.textPayload : undefined;
        if (textPayload && /rm\s+-rf|sudo|delete/i.test(textPayload)) continue;
        steps.push({
          actionType: s.actionType,
          target: typeof s.target === "string" && s.target.trim() ? s.target.trim() : frontmost,
          textPayload,
          reason: typeof s.reason === "string" ? s.reason : ""
        });
      }

      if (steps.length === 0) {
        return { goal, planningModelUsed: PLANNING_MODEL, steps: [], rawModelOutput: raw, error: "Model produced no valid steps after safety/schema filtering" };
      }

      return { goal, planningModelUsed: PLANNING_MODEL, steps, rawModelOutput: raw };
    } catch (e: any) {
      return { goal, planningModelUsed: null, steps: [], error: e.message || `${backend} unreachable` };
    }
  }
}
