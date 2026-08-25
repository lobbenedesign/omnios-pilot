/**
 * 🖥️ OMNIOS-PILOT CLIENT SCRIPT
 *
 * HONESTY NOTE: the previous version of this file rendered a canvas with
 * fake bounding boxes and a "target crosshair" driven by fields
 * (plan.elements, plan.targetCoordinates, plan.detectedApp, data.safetyCheck)
 * that the backend never returned - the plan() function crashed with a
 * TypeError on every page load (data.safetyCheck was undefined) and the
 * Execute button called POST /api/pilot/execute, an endpoint that did not
 * exist on the server (guaranteed 404). Nothing on this page ever actually
 * worked. It has been rewritten to only display data the backend genuinely
 * produces: the real captured screenshot, the real frontmost app / process
 * list, the real (or honestly-absent) local vision-model description, and
 * a real execute call wired to the now-implemented /api/pilot/execute route.
 */

let currentPlan = null;
// Tracks how the last real screenshot was fitted into the canvas, so a click
// on the canvas can be mapped back to REAL absolute screen coordinates and
// dispatched as a genuine click via /api/pilot/click. This is what closes the
// "observe -> click -> re-observe" loop the README previously said was missing.
let lastScreenshotMapping = null; // { scale, dx, dy, realWidth, realHeight }

document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  setupPilotActions();
  setupPanicControls();
  setupCanvasClickToRealClick();
  fetchCompetitorMatrix();
});

function setupTabs() {
  const tabs = document.querySelectorAll(".nav-tab");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");

      const targetId = `tab-${tab.getAttribute("data-tab")}`;
      document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
      const targetPane = document.getElementById(targetId);
      if (targetPane) targetPane.classList.add("active");
    });
  });
}

// 1. Render the REAL captured screenshot into the canvas (no fake bounding boxes).
async function drawDesktopScreen(screenshotPath) {
  const canvas = document.getElementById("screen-viewport-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "12px 'Inter'";

  if (!screenshotPath) {
    ctx.fillText("No screenshot available (screencapture failed or was denied).", 14, h / 2);
    return;
  }

  // Cache-bust so we always see the latest real capture, served from disk.
  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, w, h);
    // Fit the real screenshot into the canvas preserving aspect ratio.
    const scale = Math.min(w / img.width, h / img.height);
    const dw = img.width * scale;
    const dh = img.height * scale;
    const dx = (w - dw) / 2;
    const dy = (h - dh) / 2;
    ctx.fillStyle = "#0f172a";
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, dx, dy, dw, dh);

    // Real screenshot pixel dimensions == real screen resolution captured by
    // `screencapture` (macOS captures at native resolution), so this scale
    // factor maps canvas clicks back to genuine absolute screen coordinates.
    lastScreenshotMapping = { scale, dx, dy, realWidth: img.width, realHeight: img.height };
  };
  img.onerror = () => {
    ctx.fillText("Screenshot captured on disk but could not be loaded in-browser.", 14, h / 2);
  };
  img.src = `/api/pilot/screenshot-file?ts=${Date.now()}`;
}

// 1b. Click-to-real-click: clicking on the rendered screenshot dispatches a
// REAL macOS mouse click at the corresponding absolute screen coordinate via
// POST /api/pilot/click (System Events "click at {x,y}"). Requires the
// frontmost app to be named explicitly since the browser tab itself is
// frontmost while the click originates - defaults to whatever process the
// last /api/pilot/plan call detected as frontmost.
function setupCanvasClickToRealClick() {
  const canvas = document.getElementById("screen-viewport-canvas");
  const terminal = document.getElementById("driver-execution-output");
  if (!canvas) return;

  canvas.addEventListener("click", async (ev) => {
    if (!lastScreenshotMapping) {
      if (terminal) terminal.textContent = "// No screenshot loaded yet - click 'Analyze & Plan' first.";
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const canvasX = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const canvasY = (ev.clientY - rect.top) * (canvas.height / rect.height);
    const { scale, dx, dy, realWidth, realHeight } = lastScreenshotMapping;
    const realX = (canvasX - dx) / scale;
    const realY = (canvasY - dy) / scale;
    if (realX < 0 || realY < 0 || realX > realWidth || realY > realHeight) {
      if (terminal) terminal.textContent = "// Click was outside the rendered screenshot area - ignored.";
      return;
    }

    const targetProcess = currentPlan?.detectedFrontmostApp;
    if (terminal) terminal.textContent = `// Dispatching REAL click at screen (${Math.round(realX)}, ${Math.round(realY)}) via /api/pilot/click...`;

    try {
      const res = await fetch("/api/pilot/click", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x: realX, y: realY, process: targetProcess })
      });
      const data = await res.json();
      if (terminal) {
        terminal.textContent = res.ok && data.success
          ? `=== 🖱️ REAL PIXEL CLICK (System Events "click at") ===\n• Screen coords: (${Math.round(realX)}, ${Math.round(realY)})\n• Target process: ${data.target}\n• Latency: ${data.durationMs} ms\n✓ Real click event dispatched to macOS.`
          : `🚨 CLICK FAILED: ${data.output || data.error || "unknown error"}`;
      }
    } catch (e) {
      if (terminal) terminal.textContent = "Error: " + e.message;
    }
  });
}

// 2. Pilot Actions (Plan & Execute)
function setupPilotActions() {
  const btnPlan = document.getElementById("btn-plan-action");
  const btnExecute = document.getElementById("btn-execute-action");
  const inputGoal = document.getElementById("input-pilot-goal");
  const planBox = document.getElementById("plan-details-container");
  const terminal = document.getElementById("driver-execution-output");

  async function plan() {
    btnPlan.textContent = "👁️ Analyzing (real screencapture + process list)...";
    try {
      const res = await fetch("/api/pilot/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: inputGoal.value })
      });
      const data = await res.json();
      if (!res.ok || !data.plan) {
        planBox.innerHTML = `<span style="color:#f43f5e;">Error: ${data.error || "unknown"}</span>`;
        btnPlan.textContent = "👁️ Analyze & Plan";
        return;
      }
      currentPlan = data.plan;

      const badge = document.getElementById("badge-target-coords");
      badge.textContent = `${currentPlan.actionType.toUpperCase()} → ${currentPlan.suggestedTarget}`;

      const accBadge = document.getElementById("badge-grounding-acc");
      if (accBadge) accBadge.textContent = currentPlan.visionModelUsed ? `Vision: ${currentPlan.visionModelUsed}` : "Vision: unavailable (heuristic only)";

      const processNames = (currentPlan.realRunningProcesses || []).map(p => p.name).join(", ");

      planBox.innerHTML = `
        <strong style="color: #fff;">Real Frontmost App:</strong> ${currentPlan.detectedFrontmostApp}<br>
        <strong style="color: #fff;">Real Visible Processes:</strong> ${processNames || "(none detected)"}<br>
        <strong style="color: #fff;">Action Type:</strong> <span style="color: #38bdf8;">${currentPlan.actionType.toUpperCase()}</span> → target: ${currentPlan.suggestedTarget}<br>
        <strong style="color: #fff;">Heuristic Rationale:</strong> ${currentPlan.rationale}<br>
        ${currentPlan.visionDescription ? `<strong style="color: #fff;">Local Vision Model (${currentPlan.visionModelUsed || "n/a"}) Description:</strong> ${currentPlan.visionDescription}<br>` : ""}
        <strong style="color: #fff;">Safety Status:</strong> <span style="color: ${data.safetyCheck && data.safetyCheck.isSafe ? '#34d399' : '#f43f5e'};">${data.safetyCheck ? data.safetyCheck.reason : "n/a"}</span>
      `;

      drawDesktopScreen(currentPlan.screenshotPath);
      btnPlan.textContent = "👁️ Analyze & Plan";
    } catch (e) {
      planBox.innerHTML = `<span style="color:#f43f5e;">Request failed: ${e.message}</span>`;
      btnPlan.textContent = "👁️ Analyze & Plan";
    }
  }

  async function execute() {
    if (!currentPlan) return;
    btnExecute.textContent = "🖱️ Executing...";
    terminal.textContent = `// Dispatching real native OS driver command via /api/pilot/execute...`;

    try {
      const res = await fetch("/api/pilot/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionType: currentPlan.actionType,
          target: currentPlan.suggestedTarget,
          textPayload: inputGoal.value
        })
      });
      const data = await res.json();

      if (res.ok && data.success) {
        terminal.textContent = `=== 🖱️ NATIVE DRIVER EXECUTION (REAL osascript call) ===\n` +
          `• Command: ${data.command}\n` +
          `• Output: ${data.output}\n` +
          `• Latency: ${data.durationMs} ms\n` +
          `• Driver Subsystem: ${data.driverType}\n` +
          `✓ Real AppleScript event dispatched to macOS.`;
      } else {
        terminal.textContent = `🚨 EXECUTION BLOCKED OR FAILED: ${data.error || data.output || "unknown error"}`;
      }
      btnExecute.textContent = "🖱️ Execute Action";
    } catch (e) {
      terminal.textContent = "Error: " + e.message;
      btnExecute.textContent = "🖱️ Execute Action";
    }
  }

  btnPlan?.addEventListener("click", plan);
  btnExecute?.addEventListener("click", execute);
  plan(); // auto-plan on load
}

// 3. Panic Emergency Controls
function setupPanicControls() {
  const btnPanic = document.getElementById("btn-panic-stop");
  const btnReset = document.getElementById("btn-safety-reset");

  btnPanic?.addEventListener("click", async () => {
    try {
      await fetch("/api/safety/panic", { method: "POST" });
      document.getElementById("chip-safety-status").textContent = "🚨 EMERGENCY FROZEN";
      document.getElementById("chip-safety-status").style.color = "#f43f5e";
    } catch {}
  });

  btnReset?.addEventListener("click", async () => {
    try {
      await fetch("/api/safety/reset", { method: "POST" });
      document.getElementById("chip-safety-status").textContent = "🛡️ Safety: Active";
      document.getElementById("chip-safety-status").style.color = "#fbbf24";
    } catch {}
  });
}

// 4. Feature comparison table (no fabricated numeric scores - see src/competitor_benchmark.ts)
async function fetchCompetitorMatrix() {
  const container = document.getElementById("competitor-table-container");
  if (!container) return;

  try {
    const res = await fetch("/api/competitors");
    const competitors = await res.json();

    let html = `
      <table class="bench-table">
        <thead>
          <tr>
            <th>Project</th>
            <th>Architecture</th>
            <th>Pixel-Coordinate Grounding</th>
            <th>Safety Guard Rails</th>
            <th>Visual BBox Overlay</th>
            <th>Local Offline Privacy</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
    `;

    competitors.forEach((c, i) => {
      const isOur = i === 0;
      html += `
        <tr class="${isOur ? 'bench-row-highlight' : ''}">
          <td>${c.name}</td>
          <td>${c.architecture}</td>
          <td>${c.pixelCoordinateGrounding}</td>
          <td>${c.humanInTheLoopSafety ? '✓ Yes' : '✗ No'}</td>
          <td>${c.visualBBoxOverlay ? '✓ Yes' : '✗ No'}</td>
          <td>${c.localOfflinePrivacy ? '✓ Local' : '☁️ Cloud'}</td>
          <td style="font-size:11px; color: var(--text-muted);">${c.notes}</td>
        </tr>
      `;
    });

    html += `</tbody></table>`;
    container.innerHTML = html;
  } catch {}
}
