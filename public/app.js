/**
 * 🖥️ OMNIOS-PILOT CLIENT SCRIPT
 * Handles Canvas Desktop Viewport Rendering with Bounding Boxes,
 * Multimodal Visual Grounding Action Planning, Native Execution, and Panic Switch.
 */

let currentPlan = null;

document.addEventListener("DOMContentLoaded", () => {
  setupTabs();
  setupPilotActions();
  setupPanicControls();
  fetchCompetitorMatrix();
  drawDesktopScreen(null);
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

// 1. Desktop Canvas Screen Renderer with BBoxes & Crosshair
function drawDesktopScreen(plan) {
  const canvas = document.getElementById("screen-viewport-canvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;

  // Background desktop wallpaper
  const gradient = ctx.createLinearGradient(0, 0, w, h);
  gradient.addColorStop(0, "#0f172a");
  gradient.addColorStop(1, "#0284c7");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, w, h);

  // Top macOS menu bar
  ctx.fillStyle = "rgba(0, 0, 0, 0.4)";
  ctx.fillRect(0, 0, w, 22);
  ctx.fillStyle = "#fff";
  ctx.font = "10px 'Inter'";
  ctx.fillText("  Finder  File  Edit  View  Go  Window  Help", 14, 15);

  // Simulated Open Window (Finder / Invoice)
  ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 1;
  ctx.fillRect(70, 45, 460, 240);
  ctx.strokeRect(70, 45, 460, 240);

  // Window titlebar
  ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
  ctx.fillRect(70, 45, 460, 24);
  ctx.fillStyle = "#e2e8f0";
  ctx.font = "11px 'Inter'";
  ctx.fillText("Documents — Invoice Export (macOS Native)", 190, 61);

  // Draw Bounding Boxes if plan exists
  if (plan && plan.elements) {
    plan.elements.forEach(elem => {
      const [bx, by, bw, bh] = elem.bbox;
      // Scale coordinates to canvas width/height
      const scaleX = w / 1920;
      const scaleY = h / 1080;
      const sx = bx * scaleX;
      const sy = by * scaleY;
      const sw = bw * scaleX;
      const sh = bh * scaleY;

      ctx.strokeStyle = "#38bdf8";
      ctx.lineWidth = 1.5;
      ctx.strokeRect(sx, sy, sw, sh);

      ctx.fillStyle = "rgba(56, 189, 248, 0.2)";
      ctx.fillRect(sx, sy, sw, sh);

      // Label
      ctx.fillStyle = "#38bdf8";
      ctx.font = "8px 'Fira Code'";
      ctx.fillText(`${elem.name} (${(elem.confidence * 100).toFixed(0)}%)`, sx, sy - 4);
    });

    // Draw Simulated Target Crosshair
    const [tx, ty] = plan.targetCoordinates;
    const targetCanvasX = (tx / 1920) * w;
    const targetCanvasY = (ty / 1080) * h;

    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(targetCanvasX, targetCanvasY, 10, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(targetCanvasX - 14, targetCanvasY);
    ctx.lineTo(targetCanvasX + 14, targetCanvasY);
    ctx.moveTo(targetCanvasX, targetCanvasY - 14);
    ctx.lineTo(targetCanvasX, targetCanvasY + 14);
    ctx.stroke();
  }
}

// 2. Pilot Actions (Plan & Execute)
function setupPilotActions() {
  const btnPlan = document.getElementById("btn-plan-action");
  const btnExecute = document.getElementById("btn-execute-action");
  const inputGoal = document.getElementById("input-pilot-goal");
  const planBox = document.getElementById("plan-details-container");
  const terminal = document.getElementById("driver-execution-output");

  async function plan() {
    btnPlan.textContent = "👁️ Grounding...";
    try {
      const res = await fetch("/api/pilot/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goal: inputGoal.value })
      });
      const data = await res.json();
      currentPlan = data.plan;

      document.getElementById("badge-target-coords").textContent = `(${currentPlan.targetCoordinates[0]}, ${currentPlan.targetCoordinates[1]}) ${currentPlan.actionType.toUpperCase()}`;

      planBox.innerHTML = `
        <strong style="color: #fff;">Detected App:</strong> ${currentPlan.detectedApp}<br>
        <strong style="color: #fff;">Action Type:</strong> <span style="color: #38bdf8;">${currentPlan.actionType.toUpperCase()}</span> at [X: ${currentPlan.targetCoordinates[0]}, Y: ${currentPlan.targetCoordinates[1]}]<br>
        <strong style="color: #fff;">Vision Rationale:</strong> ${currentPlan.rationale}<br>
        <strong style="color: #fff;">Safety Status:</strong> <span style="color: #34d399;">${data.safetyCheck.reason}</span>
      `;

      drawDesktopScreen(currentPlan);
      btnPlan.textContent = "👁️ Analyze & Plan";
    } catch (e) {
      btnPlan.textContent = "👁️ Analyze & Plan";
    }
  }

  async function execute() {
    if (!currentPlan) return;
    btnExecute.textContent = "🖱️ Executing...";
    terminal.textContent = `// Dispatching native OS driver command...`;

    try {
      const res = await fetch("/api/pilot/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionType: currentPlan.actionType,
          coordinates: currentPlan.targetCoordinates,
          textPayload: currentPlan.textPayload
        })
      });
      const data = await res.json();

      if (res.ok) {
        terminal.textContent = `=== 🖱️ NATIVE DRIVER EXECUTION SUCCESS ===\n` +
          `• Command: ${data.command}\n` +
          `• Screen Target: [X: ${data.coordinates[0]}, Y: ${data.coordinates[1]}]\n` +
          `• Latency: ${data.durationMs} ms\n` +
          `• Driver Subsystem: ${data.driverType}\n` +
          `✓ Native UI event dispatched to active macOS window.`;
      } else {
        terminal.textContent = `🚨 EXECUTION BLOCKED: ${data.error}`;
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
      alert("🚨 EMERGENCY PANIC SWITCH ENGAGED! All mouse and keyboard drivers frozen.");
    } catch {}
  });

  btnReset?.addEventListener("click", async () => {
    try {
      await fetch("/api/safety/reset", { method: "POST" });
      document.getElementById("chip-safety-status").textContent = "🛡️ Safety: Active";
      document.getElementById("chip-safety-status").style.color = "#fbbf24";
      alert("✓ Safety reset. Normal autonomous OS operations resumed.");
    } catch {}
  });
}

// 4. Competitor Matrix
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
            <th>Agent / Competitor</th>
            <th>Architecture</th>
            <th>Grounding Accuracy</th>
            <th>Safety Guard Rails</th>
            <th>Visual BBox Overlay</th>
            <th>Local Offline Privacy</th>
            <th>Cost / Action</th>
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
          <td style="color: #38bdf8; font-weight: 700;">${c.coordinateGroundingAccuracy}</td>
          <td>${c.humanInTheLoopSafety ? '✓ Yes' : '✗ No'}</td>
          <td>${c.visualBBoxOverlay ? '✓ Yes' : '✗ No'}</td>
          <td>${c.localOfflinePrivacy ? '✓ 100% Local' : '☁️ Cloud Docker'}</td>
          <td>${c.costPerAction}</td>
        </tr>
      `;
    });

    html += `</tbody></table>`;
    container.innerHTML = html;
  } catch {}
}
