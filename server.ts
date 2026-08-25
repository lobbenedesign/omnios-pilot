#!/usr/bin/env bun
/**
 * 🖥️ OMNIOS-PILOT SERVER (v1.0.0)
 * Multimodal Vision-Language Desktop Automation Agent
 */

import { VisionGroundingAgent } from "./src/vision_agent";
import { MouseKeyboardDriver } from "./src/mouse_keyboard_driver";
import { SafetyGuard } from "./src/safety_guard";
import { OSCompetitorBenchmark } from "./src/competitor_benchmark";
import { join } from "path";
import { existsSync } from "fs";

const PORT = Number(process.env.PORT) || 3007;

const visionAgent = new VisionGroundingAgent();
const driver = new MouseKeyboardDriver();
const safety = new SafetyGuard();
const benchmark = new OSCompetitorBenchmark();

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

        const check = safety.evaluateAction(actionType, [0, 0], textPayload);
        if (!check.isSafe) {
          return new Response(JSON.stringify({ error: check.reason, safetyCheck: check }), { status: 403, headers });
        }

        let result: any;
        if (actionType === "activate_app") {
          result = await driver.launchApp(target);
        } else if (actionType === "keystroke") {
          result = await driver.typeText(textPayload || "");
        } else if (actionType === "notify") {
          result = await driver.showNotification("OmniOS Pilot", textPayload || "Action executed");
        } else {
          // inspect_windows / unknown: nothing destructive to dispatch, just report frontmost app.
          const frontmost = await driver.getFrontmostApp();
          result = {
            action: "inspect_windows",
            target: frontmost,
            output: `Frontmost application is ${frontmost}. No mouse/keyboard event dispatched (no destructive action requested).`,
            success: true,
            durationMs: 0,
            driverType: "AppleScript_SystemEvents_Native"
          };
        }

        return new Response(JSON.stringify({
          command: result.action,
          coordinates: body.coordinates || [0, 0],
          durationMs: result.durationMs,
          driverType: result.driverType,
          output: result.output,
          success: result.success
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

    // 5. 5-Competitor Matrix
    if (url.pathname === "/api/competitors" && req.method === "GET") {
      return new Response(JSON.stringify(benchmark.getComparison()), { headers });
    }

    return new Response("Not Found", { status: 404, headers });
  }
});
