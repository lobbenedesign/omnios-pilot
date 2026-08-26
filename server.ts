#!/usr/bin/env bun
/**
 * 🖥️ OMNIOS-PILOT SERVER (v1.0.0)
 * Multimodal Vision-Language Desktop Automation Agent
 */

import { VisionGroundingAgent } from "./src/vision_agent";
import { MouseKeyboardDriver } from "./src/mouse_keyboard_driver";
import { SafetyGuard } from "./src/safety_guard";
import { OSCompetitorBenchmark } from "./src/competitor_benchmark";
import { ActionHistoryLog } from "./src/action_history";
import { computePixelDiff } from "./src/verification";
import { GroundingAgent } from "./src/grounding_agent";
import { join } from "path";
import { existsSync } from "fs";

const PORT = Number(process.env.PORT) || 3007;

const visionAgent = new VisionGroundingAgent();
const driver = new MouseKeyboardDriver();
const safety = new SafetyGuard();
const benchmark = new OSCompetitorBenchmark();
const history = new ActionHistoryLog();
const grounding = new GroundingAgent();

/**
 * Reads the REAL logical screen size (points, not pixels) via the same
 * AppleScript call /api/status already uses. Needed to convert a coordinate
 * read off a screenshot (which screencapture writes at native/Retina pixel
 * resolution) into the coordinate space System Events' "click at" expects.
 * See src/grounding_agent.ts module header for the measured 2x mismatch on
 * this machine.
 */
async function getLogicalScreenSize(): Promise<{ width: number; height: number } | null> {
  try {
    const proc = Bun.spawn(["osascript", "-e", 'tell application "Finder" to get bounds of window of desktop'], { stdout: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    const parts = out.split(", ").map(Number);
    if (parts.length === 4 && Number.isFinite(parts[2]) && Number.isFinite(parts[3])) {
      return { width: parts[2], height: parts[3] };
    }
  } catch {}
  return null;
}

async function getPngSize(path: string): Promise<{ width: number; height: number } | null> {
  // Cheap real PNG header parse (IHDR width/height at fixed offsets) - avoids
  // spawning python3 just to read dimensions the grounding agent already
  // determined internally; used here only for the click-space conversion.
  try {
    const buf = await Bun.file(path).arrayBuffer();
    const view = new DataView(buf);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width > 0 && height > 0) return { width, height };
  } catch {}
  return null;
}

/**
 * Real observe-act-verify wrapper around a single driver call: captures a
 * genuine "before" screenshot, runs the action, waits briefly for the UI to
 * settle, captures a genuine "after" screenshot, computes a real pixel diff
 * between the two files, and (if Ollama is reachable) captions the "after"
 * screenshot. See src/verification.ts for what this honestly does and does
 * not prove.
 */
async function runWithVerification(run: () => Promise<any>) {
  // Distinct paths for "before" and "after" - captureScreen() defaults to a
  // single fixed path, and using it for both captures would silently
  // overwrite the "before" file with the "after" one before it could be
  // diffed (a real bug hit during manual testing of this feature; the diff
  // always reported 0% changed because both variables pointed at the same
  // file on disk). The "after" capture also refreshes the fixed path the UI
  // polls via /api/pilot/screenshot-file, so the dashboard still shows the
  // latest real screen state.
  const before = await visionAgent.captureScreen("/tmp/omnios_verify_before.png");
  const result = await run();
  await Bun.sleep(500); // let the UI settle before the "after" capture
  const after = await visionAgent.captureScreen(); // default fixed path, also used by the UI

  let diff: Awaited<ReturnType<typeof computePixelDiff>> = {
    changedPixelPercent: null, width: null, height: null, method: "unavailable", error: "before/after screenshot missing"
  };
  if (before && after) {
    diff = await computePixelDiff(before, after);
  }

  let afterDescription: string | null = null;
  let visionModelUsed: string | null = null;
  if (after) {
    const vision = await visionAgent.describeScreenWithOllama(after);
    afterDescription = vision.description;
    visionModelUsed = vision.model;
  }

  return {
    result,
    verification: {
      beforeScreenshot: before,
      afterScreenshot: after,
      changedPixelPercent: diff.changedPixelPercent,
      diffMethod: diff.method,
      diffError: diff.error,
      afterDescription,
      visionModelUsed
    }
  };
}

console.log(`\n======================================================`);
console.log(`🖥️ OMNIOS-PILOT running on http://localhost:${PORT}`);
console.log(`👁️ Vision description: local Ollama (moondream) if reachable, else heuristic-only fallback`);
console.log(`🖱️ Native Mouse/Keyboard Driver: AppleScript / System Events (osascript)`);
console.log(`🛡️ Human-in-the-Loop Safety & Panic Switch: Online`);
console.log(`======================================================\n`);

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    };

    if (req.method === "OPTIONS") return new Response(null, { headers });

    // Serve Static UI Assets
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const p = join(__dirname, "public", "index.html");
      return new Response(Bun.file(p), { headers: { "Content-Type": "text/html" } });
    }
    if (url.pathname === "/app.js") {
      const p = join(__dirname, "public", "app.js");
      return new Response(Bun.file(p), { headers: { "Content-Type": "application/javascript" } });
    }
    if (url.pathname === "/style.css") {
      const p = join(__dirname, "public", "style.css");
      return new Response(Bun.file(p), { headers: { "Content-Type": "text/css" } });
    }
    if (url.pathname.startsWith("/public/")) {
      const p = join(__dirname, url.pathname);
      if (existsSync(p)) return new Response(Bun.file(p));
    }

    // 1. Status - reports genuinely detected state, not fixed marketing strings.
    if (url.pathname === "/api/status" && req.method === "GET") {
      let ollamaReachable = false;
      try {
        const r = await fetch(`${process.env.OLLAMA_URL || "http://localhost:11434"}/api/tags`, { signal: AbortSignal.timeout(1500) });
        ollamaReachable = r.ok;
      } catch {}

      let screenResolution = "unknown";
      try {
        const proc = Bun.spawn(["osascript", "-e", 'tell application "Finder" to get bounds of window of desktop'], { stdout: "pipe" });
        const out = (await new Response(proc.stdout).text()).trim();
        const parts = out.split(", ").map(Number);
        if (parts.length === 4) screenResolution = `${parts[2]}x${parts[3]}`;
      } catch {}

      return new Response(JSON.stringify({
        status: "online",
        version: "1.0.0-omnios",
        groundingModel: ollamaReachable ? "Local Ollama (moondream) reachable" : "No vision model reachable - heuristic fallback only",
        safetyStatus: "nominal",
        activeScreenResolution: screenResolution
      }), { headers });
    }

    // 2. Parse Screen & Real Process Grounding
    if (url.pathname === "/api/pilot/plan" && req.method === "POST") {
      try {
        let body: any = {};
        try { body = await req.json(); } catch {}
        const goal = body.goal || "Apri il Finder e cerca un file";
        const plan = await visionAgent.parseScreenAndPlan(goal);
        const safetyCheck = safety.evaluateAction(plan.actionType, [0, 0], goal);
        return new Response(JSON.stringify({ plan, safetyCheck }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 2b. Execute a previously planned action for real.
    // This endpoint was MISSING entirely in the original codebase: the frontend
    // (public/app.js) called POST /api/pilot/execute on every "Execute Action"
    // click and always received a 404, so the button never did anything real.
    if (url.pathname === "/api/pilot/execute" && req.method === "POST") {
      try {
        let body: any = {};
        try { body = await req.json(); } catch {}
        const actionType: string = body.actionType || "inspect_windows";
        const target: string = body.target || "Finder";
        const textPayload: string | undefined = body.textPayload;
        const wantVerify: boolean = Boolean(body.verify);

        const coordsForCheck: [number, number] = Array.isArray(body.coordinates) ? [body.coordinates[0], body.coordinates[1]] : [0, 0];
        const check = safety.evaluateAction(actionType, coordsForCheck, textPayload);
        if (!check.isSafe) {
          return new Response(JSON.stringify({ error: check.reason, safetyCheck: check }), { status: 403, headers });
        }

        const dispatch = async (): Promise<any> => {
          if (actionType === "activate_app") {
            return await driver.launchApp(target);
          } else if (actionType === "keystroke") {
            return await driver.typeText(textPayload || "");
          } else if (actionType === "click") {
            const [cx, cy] = Array.isArray(body.coordinates) ? body.coordinates : [0, 0];
            return await driver.clickAt(cx, cy, target || undefined);
          } else if (actionType === "double_click") {
            const [cx, cy] = Array.isArray(body.coordinates) ? body.coordinates : [0, 0];
            return await driver.doubleClickAt(cx, cy, target || undefined);
          } else if (actionType === "notify") {
            return await driver.showNotification("OmniOS Pilot", textPayload || "Action executed");
          } else {
            // inspect_windows / unknown: nothing destructive to dispatch, just report frontmost app.
            const frontmost = await driver.getFrontmostApp();
            return {
              action: "inspect_windows",
              target: frontmost,
              output: `Frontmost application is ${frontmost}. No mouse/keyboard event dispatched (no destructive action requested).`,
              success: true,
              durationMs: 0,
              driverType: "AppleScript_SystemEvents_Native"
            };
          }
        };

        let result: any;
        let verification: any = null;
        if (wantVerify) {
          const wrapped = await runWithVerification(dispatch);
          result = wrapped.result;
          verification = wrapped.verification;
        } else {
          result = await dispatch();
        }

        history.append({
          actionType,
          target,
          textPayload,
          coordinates: Array.isArray(body.coordinates) ? [body.coordinates[0], body.coordinates[1]] : undefined,
          success: result.success,
          output: result.output,
          durationMs: result.durationMs,
          safetyRiskLevel: check.riskLevel,
          verification
        });

        return new Response(JSON.stringify({
          command: result.action,
          coordinates: body.coordinates || [0, 0],
          durationMs: result.durationMs,
          driverType: result.driverType,
          output: result.output,
          success: result.success,
          verification
        }), { status: result.success ? 200 : 500, headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 3. Real Running Processes
    if (url.pathname === "/api/pilot/processes" && req.method === "GET") {
      const data = await visionAgent.getRealRunningProcesses();
      return new Response(JSON.stringify(data), { headers });
    }

    // 4. Real Screen Capture
    if (url.pathname === "/api/pilot/screenshot" && req.method === "GET") {
      const path = await visionAgent.captureScreen();
      return new Response(JSON.stringify({ screenshotPath: path, timestamp: new Date().toISOString() }), { headers });
    }

    // 4b. Serve the actual captured screenshot PNG bytes to the browser UI.
    if (url.pathname === "/api/pilot/screenshot-file" && req.method === "GET") {
      const p = "/tmp/omnios_live_capture.png";
      if (!existsSync(p)) return new Response("No screenshot captured yet", { status: 404, headers });
      return new Response(Bun.file(p), { headers: { "Content-Type": "image/png" } });
    }

    // 5. Real Launch App
    if (url.pathname === "/api/pilot/launch" && req.method === "POST") {
      try {
        let body: any = {};
        try { body = await req.json(); } catch {}
        const app = body.app || "Finder";
        const res = await driver.launchApp(app);
        return new Response(JSON.stringify(res), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 6. Real Type Text Keystrokes
    if (url.pathname === "/api/pilot/type" && req.method === "POST") {
      try {
        let body: any = {};
        try { body = await req.json(); } catch {}
        const text = body.text || "Hello from OmniOS Pilot";
        const res = await driver.typeText(text);
        return new Response(JSON.stringify(res), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 6b. Real Pixel-Coordinate Click (verified: System Events "click at {x,y}"
    // sent to a named process, exit code 0 on this machine).
    if (url.pathname === "/api/pilot/click" && req.method === "POST") {
      try {
        let body: any = {};
        try { body = await req.json(); } catch {}
        const x = Number(body.x) || 0;
        const y = Number(body.y) || 0;
        const process = body.process as string | undefined;
        const double = Boolean(body.double);
        const res = double ? await driver.doubleClickAt(x, y, process) : await driver.clickAt(x, y, process);
        return new Response(JSON.stringify(res), { status: res.success ? 200 : 500, headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 6c. Real Keyboard Shortcut (key code + modifiers, e.g. Cmd+C = keyCode 8, ["command down"]).
    if (url.pathname === "/api/pilot/keycode" && req.method === "POST") {
      try {
        let body: any = {};
        try { body = await req.json(); } catch {}
        const keyCode = Number(body.keyCode);
        const modifiers: string[] = Array.isArray(body.modifiers) ? body.modifiers : [];
        if (!Number.isFinite(keyCode)) {
          return new Response(JSON.stringify({ error: "keyCode (number) is required" }), { status: 400, headers });
        }
        const res = await driver.pressKeyCode(keyCode, modifiers);
        return new Response(JSON.stringify(res), { status: res.success ? 200 : 500, headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 6d. Real click-grounding refinement (crop-and-reask): locates a
    // described UI element on a FRESH real screenshot via GroundingAgent and
    // returns the estimated coordinate + an honest confidence label, WITHOUT
    // dispatching any click. See src/grounding_agent.ts for the technique
    // and its measured real limitations.
    if (url.pathname === "/api/pilot/locate" && req.method === "POST") {
      try {
        let body: any = {};
        try { body = await req.json(); } catch {}
        const targetDescription: string = body.targetDescription || "";
        const keywords: string[] = Array.isArray(body.keywords) && body.keywords.length
          ? body.keywords
          : targetDescription.split(/\s+/).filter((w: string) => w.length > 2);
        if (!targetDescription || keywords.length === 0) {
          return new Response(JSON.stringify({ error: "targetDescription (and optionally keywords[]) is required" }), { status: 400, headers });
        }

        const screenshot = await visionAgent.captureScreen("/tmp/omnios_ground_locate.png");
        if (!screenshot) {
          return new Response(JSON.stringify({ error: "Real screenshot capture failed" }), { status: 500, headers });
        }

        const result = await grounding.locate(screenshot, targetDescription, keywords, {
          coarseRows: Number(body.coarseRows) || undefined,
          coarseCols: Number(body.coarseCols) || undefined,
          fineRows: Number(body.fineRows) || undefined,
          fineCols: Number(body.fineCols) || undefined,
          upscale: Number(body.upscale) || undefined
        });

        if (result.found && result.screenshotPixel) {
          const [pngSize, logicalSize] = await Promise.all([getPngSize(screenshot), getLogicalScreenSize()]);
          if (pngSize && logicalSize) {
            const converted = GroundingAgent.toClickSpace(result.screenshotPixel, pngSize, logicalSize);
            result.clickPoint = converted.clickPoint;
            result.scaleFactor = converted.scaleFactor;
          }
        }

        return new Response(JSON.stringify({ screenshotPath: screenshot, ...result }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 6e. Locate-then-click: runs the same crop-and-reask grounding as
    // /api/pilot/locate, then - only if a target was actually found - passes
    // the real safety check and dispatches a real click at the refined
    // click-space coordinate via MouseKeyboardDriver.clickAt. The response's
    // "confidence" field ("high"/"low"/"not_found") is carried through
    // honestly rather than silently proceeding as if grounding were certain;
    // a "not_found" result is refused (404) rather than clicking a guess.
    if (url.pathname === "/api/pilot/click-by-description" && req.method === "POST") {
      try {
        let body: any = {};
        try { body = await req.json(); } catch {}
        const targetDescription: string = body.targetDescription || "";
        const keywords: string[] = Array.isArray(body.keywords) && body.keywords.length
          ? body.keywords
          : targetDescription.split(/\s+/).filter((w: string) => w.length > 2);
        if (!targetDescription || keywords.length === 0) {
          return new Response(JSON.stringify({ error: "targetDescription (and optionally keywords[]) is required" }), { status: 400, headers });
        }

        const screenshot = await visionAgent.captureScreen("/tmp/omnios_ground_click.png");
        if (!screenshot) {
          return new Response(JSON.stringify({ error: "Real screenshot capture failed" }), { status: 500, headers });
        }
        const result = await grounding.locate(screenshot, targetDescription, keywords);

        if (!result.found || !result.screenshotPixel) {
          return new Response(JSON.stringify({ error: "Target not found on real screen", confidence: result.confidence, reason: result.reason, coarseGrid: result.coarseGrid }), { status: 404, headers });
        }

        const [pngSize, logicalSize] = await Promise.all([getPngSize(screenshot), getLogicalScreenSize()]);
        if (!pngSize || !logicalSize) {
          return new Response(JSON.stringify({ error: "Could not determine real screen/screenshot dimensions for coordinate conversion" }), { status: 500, headers });
        }
        const { clickPoint, scaleFactor } = GroundingAgent.toClickSpace(result.screenshotPixel, pngSize, logicalSize);

        const check = safety.evaluateAction("click", [clickPoint.x, clickPoint.y], targetDescription);
        if (!check.isSafe) {
          return new Response(JSON.stringify({ error: check.reason, safetyCheck: check }), { status: 403, headers });
        }

        const process = body.process as string | undefined;
        const clickResult = body.double
          ? await driver.doubleClickAt(clickPoint.x, clickPoint.y, process)
          : await driver.clickAt(clickPoint.x, clickPoint.y, process);

        history.append({
          actionType: "click_by_description",
          target: targetDescription,
          coordinates: [clickPoint.x, clickPoint.y],
          success: clickResult.success,
          output: `${clickResult.output} [grounding confidence: ${result.confidence}]`,
          durationMs: clickResult.durationMs,
          safetyRiskLevel: check.riskLevel
        });

        return new Response(JSON.stringify({
          targetDescription,
          confidence: result.confidence,
          reason: result.reason,
          screenshotPixel: result.screenshotPixel,
          clickPoint,
          scaleFactor,
          queriesIssued: result.queriesIssued,
          elapsedMs: result.elapsedMs,
          clickResult
        }), { status: clickResult.success ? 200 : 500, headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 7. Real Native Notification
    if (url.pathname === "/api/pilot/notify" && req.method === "POST") {
      try {
        let body: any = {};
        try { body = await req.json(); } catch {}
        const title = body.title || "OmniOS Pilot";
        const msg = body.message || "Action executed successfully";
        const res = await driver.showNotification(title, msg);
        return new Response(JSON.stringify(res), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 4. Panic Switch Stop / Resume
    if (url.pathname === "/api/safety/panic" && req.method === "POST") {
      const res = safety.triggerPanicStop();
      return new Response(JSON.stringify(res), { headers });
    }
    if (url.pathname === "/api/safety/reset" && req.method === "POST") {
      const res = safety.resetSafety();
      return new Response(JSON.stringify(res), { headers });
    }

    // 8. Real Action History / Audit Log (disk-persisted, see src/action_history.ts)
    if (url.pathname === "/api/pilot/history" && req.method === "GET") {
      const limit = Number(url.searchParams.get("limit")) || 50;
      return new Response(JSON.stringify(history.getHistory(limit)), { headers });
    }
    if (url.pathname === "/api/pilot/history" && req.method === "DELETE") {
      const res = await history.clear();
      return new Response(JSON.stringify(res), { headers });
    }

    // 9. Real Multi-Step Planning: decomposes a goal into steps via a local
    // Ollama text model (see VisionGroundingAgent.planMultiStep).
    if (url.pathname === "/api/pilot/plan-multistep" && req.method === "POST") {
      try {
        let body: any = {};
        try { body = await req.json(); } catch {}
        const goal = body.goal || "Apri TextEdit e scrivi una nota di prova";
        const plan = await visionAgent.planMultiStep(goal);
        return new Response(JSON.stringify(plan), { headers: { ...headers } });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 9b. Real Multi-Step Execution: runs each planned step sequentially
    // through the same safety guard + observe-act-verify loop as a single
    // /api/pilot/execute call, stopping immediately on the first unsafe or
    // failed step rather than plowing ahead. Every step is appended to the
    // real action history log with its plan goal/index for audit.
    if (url.pathname === "/api/pilot/execute-plan" && req.method === "POST") {
      try {
        let body: any = {};
        try { body = await req.json(); } catch {}
        const steps: any[] = Array.isArray(body.steps) ? body.steps : [];
        const goal: string = body.goal || "";
        const wantVerify: boolean = body.verify !== false; // verify by default for multi-step runs

        const trace: any[] = [];
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          const actionType: string = step.actionType || "inspect_windows";
          const target: string = step.target || "Finder";
          const textPayload: string | undefined = step.textPayload;

          const check = safety.evaluateAction(actionType, [0, 0], textPayload);
          if (!check.isSafe) {
            trace.push({ stepIndex: i, actionType, target, blocked: true, safetyCheck: check });
            break;
          }

          const dispatch = async (): Promise<any> => {
            if (actionType === "activate_app") return await driver.launchApp(target);
            if (actionType === "keystroke") return await driver.typeText(textPayload || "");
            if (actionType === "notify") return await driver.showNotification("OmniOS Pilot Plan", textPayload || "Step executed");
            const frontmost = await driver.getFrontmostApp();
            return {
              action: "inspect_windows",
              target: frontmost,
              output: `Frontmost application is ${frontmost}.`,
              success: true,
              durationMs: 0,
              driverType: "AppleScript_SystemEvents_Native"
            };
          };

          let result: any;
          let verification: any = null;
          if (wantVerify) {
            const wrapped = await runWithVerification(dispatch);
            result = wrapped.result;
            verification = wrapped.verification;
          } else {
            result = await dispatch();
          }

          history.append({
            actionType,
            target,
            textPayload,
            success: result.success,
            output: result.output,
            durationMs: result.durationMs,
            safetyRiskLevel: check.riskLevel,
            verification,
            planStepIndex: i,
            planGoal: goal
          });

          trace.push({ stepIndex: i, actionType, target, textPayload, result, verification, blocked: false });

          if (!result.success) break; // stop the plan on the first real failure
        }

        return new Response(JSON.stringify({ goal, totalSteps: steps.length, executedSteps: trace.length, trace }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 5. 5-Competitor Matrix
    if (url.pathname === "/api/competitors" && req.method === "GET") {
      return new Response(JSON.stringify(benchmark.getComparison()), { headers });
    }

    return new Response("Not Found", { status: 404, headers });
  }
});
