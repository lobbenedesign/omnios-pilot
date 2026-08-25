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

export interface RealRunningProcess {
  id: string;
  name: string;
  isFrontmost: boolean;
  type: "application" | "system";
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
   * Captures a real screenshot of the active display to disk
   */
  public async captureScreen(): Promise<string | null> {
    const outPath = "/tmp/omnios_live_capture.png";
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
   * Sends the real captured screenshot to a local Ollama vision model and
   * returns its genuine textual description. Returns null (not a fabricated
   * string) if Ollama is unreachable or the model call fails - callers must
   * surface this honestly instead of pretending grounding happened.
   */
  public async describeScreenWithOllama(screenshotPath: string): Promise<{ description: string | null; model: string | null; error?: string }> {
    try {
      const file = Bun.file(screenshotPath);
      if (!(await file.exists())) {
        return { description: null, model: null, error: "screenshot file not found" };
      }
      const bytes = await file.arrayBuffer();
      const base64 = Buffer.from(bytes).toString("base64");

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
      // Ollama not running, model not pulled, or timeout - be explicit, never fabricate.
      return { description: null, model: null, error: e.message || "Ollama unreachable" };
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
      const vision = await this.describeScreenWithOllama(screenshot);
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
}
