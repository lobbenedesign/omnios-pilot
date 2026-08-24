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
console.log(`👁️ Multimodal UI Grounding (UI-TARS / ShowUI): Active`);
console.log(`🖱️ Native Mouse/Keyboard CoreGraphics Driver: Ready`);
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

    // 1. Status
    if (url.pathname === "/api/status" && req.method === "GET") {
      return new Response(JSON.stringify({
        status: "online",
        version: "1.0.0-omnios",
        groundingModel: "Multimodal Vision VLM",
        safetyStatus: "nominal",
        activeScreenResolution: "1920x1080 (Retina 2x)"
      }), { headers });
    }

    // 2. Parse Screen & Plan Action
    if (url.pathname === "/api/pilot/plan" && req.method === "POST") {
      try {
        let body: any = {};
        try { body = await req.json(); } catch {}
        const goal = body.goal || "Apri il Finder e cerca la fattura di Agosto";
        const plan = await visionAgent.parseScreenAndPlan(goal);
        const safetyCheck = safety.evaluateAction(plan.actionType, plan.targetCoordinates, plan.textPayload);

        return new Response(JSON.stringify({ plan, safetyCheck }), { headers });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
      }
    }

    // 3. Execute Driver Action
    if (url.pathname === "/api/pilot/execute" && req.method === "POST") {
      try {
        let body: any = {};
        try { body = await req.json(); } catch {}
        const actionType = body.actionType || "click";
        const coords: [number, number] = body.coordinates || [890, 338];
        const payload = body.textPayload;

        const safetyCheck = safety.evaluateAction(actionType, coords, payload);
        if (!safetyCheck.isSafe) {
          return new Response(JSON.stringify({ error: safetyCheck.reason }), { status: 403, headers });
        }

        const result = await driver.executeAction(actionType, coords, payload);
        return new Response(JSON.stringify(result), { headers });
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
