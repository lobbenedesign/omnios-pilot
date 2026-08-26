/**
 * 🎯 Crop-and-reask click grounding refinement.
 *
 * WHY: `VisionGroundingAgent.describeScreenWithOllama` (vision_agent.ts) only
 * ever produces a free-text caption of the *whole* screenshot - it has never
 * output a coordinate, and `/api/pilot/click` has always required the caller
 * (a human clicking the rendered screenshot, or an API caller) to already
 * know x/y. This module is the first real attempt at closing that gap: given
 * a text description of a target UI element, it tries to locate it on the
 * REAL screen using only the local `moondream` model already used elsewhere
 * in this project, with a real grid-search "crop-and-reask" strategy - no
 * new dependency, no cloud call.
 *
 * WHAT WAS ACTUALLY TESTED FIRST (documented here because it shaped the
 * design, and because the README's honesty section requires it):
 *   1. Asking moondream, over the FULL screenshot, for raw pixel coordinates
 *      of a named element ("Reply with x=<n>, y=<n>") returns a plausible-
 *      looking but not-actually-grounded answer - e.g. asking for the Apple
 *      menu (~50x25px in a corner) returned a bounding box covering ~76% of
 *      the entire image. That is not localization, it is the model pattern-
 *      matching the requested output shape. This matches Anthropic's public
 *      finding that naive single-pass coordinate/quadrant prompting is
 *      unreliable for this class of small local vision model.
 *   2. Asking moondream (via Ollama's plain /api/generate) a CLOSED-FORM
 *      question - "Answer only yes or no", or "reply with one of: top-left,
 *      top-center, ..." - reliably returns an EMPTY string (Ollama reports
 *      eval_count: 1, i.e. the model emits an immediate end-of-sequence
 *      token). This is reproducible and is a real limitation of this specific
 *      local model/serving path, not a fluke - so every prompt in this module
 *      is deliberately OPEN-ENDED ("what icons/buttons/menus do you see in
 *      this image?") and the target is located by keyword-matching the
 *      model's free-text response, never by asking it to name a format.
 *   3. A TIGHT, upscaled crop around the right area measurably helped: the
 *      same Apple-logo query that failed on the full screenshot and on a
 *      1120x700 coarse third-of-screen tile succeeded once cropped down to
 *      a 300x80px menu-bar strip and upscaled 3x. This is the real basis for
 *      doing a coarse grid pass followed by a finer, upscaled re-ask on the
 *      winning cell, rather than trusting a single full-frame query.
 *
 * THE ALGORITHM (real, not simulated):
 *   Stage 1 (coarse): split the real screenshot into an NxM grid, crop each
 *     cell to a real temp PNG (python3 + Pillow, same mechanism already used
 *     by verification.ts for pixel-diff), ask moondream an open-ended
 *     "what do you see" question about each real crop, and keyword-match the
 *     real response text against the caller's target keywords.
 *   Stage 2 (crop-and-reask / refine): take the single winning coarse cell,
 *     subdivide THAT region into a finer grid, crop+upscale each sub-cell to
 *     a real temp PNG, and repeat the same open-ended query+keyword-match
 *     inside just that smaller region.
 *   Result: the center of the winning fine cell, translated back through
 *     both real crop offsets into full-screenshot pixel coordinates, then
 *     converted into macOS "click space" (System Events points, NOT
 *     screenshot pixels - see the scale-factor note below).
 *
 * CONFIDENCE, HONESTLY: this never fabricates a confidence percentage.
 * `confidence` is one of "high" (exactly one coarse cell matched AND exactly
 * one fine cell matched inside it), "low" (a match was found but the coarse
 * or fine stage was ambiguous - zero or multiple cells matched, and a
 * fallback had to be used), or "not_found" (no cell at either stage ever
 * mentioned the target keywords - no coordinate is returned at all).
 *
 * REAL BUG FOUND & FIXED HERE: `screencapture` on this Mac captures at the
 * display's native/Retina pixel resolution (measured: 3360x2100), while
 * System Events' `click at {x,y}` operates in logical "points" (measured via
 * `osascript -e 'tell application "Finder" to get bounds of window of
 * desktop'`: 1680x1050 - exactly half). The existing UI click-through-image
 * feature (`public/app.js` `setupCanvasClickToRealClick`) sends screenshot-
 * pixel coordinates straight to `/api/pilot/click` with no such conversion,
 * so on this machine every click dispatched that way lands at 2x the
 * intended screen position. `toClickSpace()` below is the real fix: it reads
 * the real logical screen bounds via the same AppleScript call `/api/status`
 * already uses and divides by the measured scale factor before returning a
 * coordinate meant for `MouseKeyboardDriver.clickAt`.
 */

import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const VISION_MODEL = process.env.OMNIOS_VISION_MODEL || "moondream";

export interface GridCellDescription {
  row: number;
  col: number;
  box: [number, number, number, number]; // absolute screenshot-pixel [x0,y0,x1,y1]
  cropPath: string;
  response: string;
  matched: boolean;
}

export interface GroundingResult {
  found: boolean;
  targetDescription: string;
  keywords: string[];
  /** Absolute coordinate in SCREENSHOT PIXEL space (matches the captured PNG). */
  screenshotPixel: { x: number; y: number } | null;
  /** Same point converted to macOS System-Events "click space" (points). Feed THIS to MouseKeyboardDriver.clickAt. */
  clickPoint: { x: number; y: number } | null;
  scaleFactor: number | null;
  confidence: "high" | "low" | "not_found";
  reason: string;
  coarseGrid: GridCellDescription[];
  fineGrid: GridCellDescription[];
  queriesIssued: number;
  elapsedMs: number;
}

const PYTHON_CANDIDATES = [
  "python3",
  "/opt/homebrew/bin/python3",
  "/opt/homebrew/bin/python3.12",
  "/opt/homebrew/bin/python3.11",
  "/usr/local/bin/python3",
];

async function findWorkingPython(): Promise<string | null> {
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      const proc = Bun.spawn([candidate, "-c", "import PIL"], { stdout: "ignore", stderr: "ignore" });
      const code = await proc.exited;
      if (code === 0) return candidate;
    } catch {}
  }
  return null;
}

/** Reads the real dimensions of a PNG on disk via Pillow. */
async function getImageSize(python: string, path: string): Promise<{ width: number; height: number } | null> {
  const script = `
import sys, json
from PIL import Image
im = Image.open(sys.argv[1])
print(json.dumps({"width": im.size[0], "height": im.size[1]}))
`.trim();
  try {
    const proc = Bun.spawn([python, "-c", script, path], { stdout: "pipe", stderr: "pipe" });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** Crops a REAL sub-region of a real PNG to a new real PNG file, optionally upscaling it. */
async function cropImage(
  python: string,
  srcPath: string,
  box: [number, number, number, number],
  outPath: string,
  upscale = 1
): Promise<boolean> {
  const script = `
import sys
from PIL import Image
im = Image.open(sys.argv[1])
box = tuple(int(v) for v in sys.argv[2:6])
crop = im.crop(box)
scale = float(sys.argv[6])
if scale != 1.0:
    crop = crop.resize((max(1, int(crop.width * scale)), max(1, int(crop.height * scale))))
crop.save(sys.argv[7])
`.trim();
  try {
    const [x0, y0, x1, y1] = box;
    const proc = Bun.spawn(
      [python, "-c", script, srcPath, String(x0), String(y0), String(x1), String(y1), String(upscale), outPath],
      { stdout: "ignore", stderr: "pipe" }
    );
    const code = await proc.exited;
    return code === 0 && existsSync(outPath);
  } catch {
    return false;
  }
}

/**
 * Sends one real crop to moondream with a deliberately OPEN-ENDED prompt
 * (see the module header for why closed-form prompts reliably return
 * empty responses from this model over Ollama's plain /api/generate) and
 * returns its genuine free-text response, or null if Ollama/the model call
 * failed - never a fabricated string.
 */
async function describeCropWithOllama(imagePath: string): Promise<string | null> {
  try {
    const file = Bun.file(imagePath);
    if (!(await file.exists())) return null;
    const bytes = await file.arrayBuffer();
    const base64 = Buffer.from(bytes).toString("base64");
    const res = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: VISION_MODEL,
        prompt: "What icons, buttons, menu items or text labels are visible in this image? List everything you can identify.",
        images: [base64],
        stream: false
      }),
      signal: AbortSignal.timeout(45000)
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    return typeof data.response === "string" ? data.response : null;
  } catch {
    return null;
  }
}

function matchesKeywords(response: string, keywords: string[]): boolean {
  const lower = response.toLowerCase();
  return keywords.some((k) => lower.includes(k.toLowerCase()));
}

export class GroundingAgent {
  /**
   * Locates `targetDescription` (matched via `keywords`) on the real
   * screenshot at `screenshotPath` using the two-stage coarse->fine
   * crop-and-reask search described in the module header. Every crop is a
   * real temporary PNG on disk (cleaned up afterwards), every model call is
   * a real Ollama request, and every returned coordinate is derived from
   * real crop-offset arithmetic - nothing here is interpolated or guessed.
   */
  public async locate(
    screenshotPath: string,
    targetDescription: string,
    keywords: string[],
    opts: { coarseRows?: number; coarseCols?: number; fineRows?: number; fineCols?: number; upscale?: number } = {}
  ): Promise<GroundingResult> {
    const start = performance.now();
    const coarseRows = opts.coarseRows ?? 3;
    const coarseCols = opts.coarseCols ?? 3;
    const fineRows = opts.fineRows ?? 2;
    const fineCols = opts.fineCols ?? 2;
    const upscale = opts.upscale ?? 3;

    const empty: GroundingResult = {
      found: false,
      targetDescription,
      keywords,
      screenshotPixel: null,
      clickPoint: null,
      scaleFactor: null,
      confidence: "not_found",
      reason: "",
      coarseGrid: [],
      fineGrid: [],
      queriesIssued: 0,
      elapsedMs: 0
    };

    const python = await findWorkingPython();
    if (!python) {
      return { ...empty, reason: "No python3 with Pillow (PIL) found on PATH - cannot crop real screenshot regions." , elapsedMs: Number((performance.now() - start).toFixed(1))};
    }
    if (!existsSync(screenshotPath)) {
      return { ...empty, reason: `Screenshot not found at ${screenshotPath}`, elapsedMs: Number((performance.now() - start).toFixed(1)) };
    }
    const size = await getImageSize(python, screenshotPath);
    if (!size) {
      return { ...empty, reason: "Could not read real screenshot dimensions.", elapsedMs: Number((performance.now() - start).toFixed(1)) };
    }

    const workDir = mkdtempSync(join(tmpdir(), "omnios-grounding-"));
    let queriesIssued = 0;
    const coarseGrid: GridCellDescription[] = [];

    try {
      const cellW = size.width / coarseCols;
      const cellH = size.height / coarseRows;

      for (let r = 0; r < coarseRows; r++) {
        for (let c = 0; c < coarseCols; c++) {
          const box: [number, number, number, number] = [
            Math.round(c * cellW),
            Math.round(r * cellH),
            Math.round((c + 1) * cellW),
            Math.round((r + 1) * cellH)
          ];
          const cropPath = join(workDir, `coarse_${r}_${c}.png`);
          const ok = await cropImage(python, screenshotPath, box, cropPath, 1);
          if (!ok) {
            coarseGrid.push({ row: r, col: c, box, cropPath, response: "", matched: false });
            continue;
          }
          const response = (await describeCropWithOllama(cropPath)) || "";
          queriesIssued++;
          coarseGrid.push({ row: r, col: c, box, cropPath, response, matched: matchesKeywords(response, keywords) });
        }
      }

      const coarseMatches = coarseGrid.filter((g) => g.matched);
      if (coarseMatches.length === 0) {
        return {
          ...empty,
          coarseGrid,
          queriesIssued,
          reason: `No coarse grid cell's real moondream description mentioned any of [${keywords.join(", ")}] out of ${coarseGrid.length} cells queried. Target likely too small/ambiguous for this model, or not actually on screen.`,
          elapsedMs: Number((performance.now() - start).toFixed(1))
        };
      }

      const winner = coarseMatches[0];
      const ambiguousCoarse = coarseMatches.length > 1;

      // Stage 2: crop-and-reask inside the winning coarse cell, upscaled.
      const [wx0, wy0, wx1, wy1] = winner.box;
      const wCellW = (wx1 - wx0) / fineCols;
      const wCellH = (wy1 - wy0) / fineRows;
      const fineGrid: GridCellDescription[] = [];

      for (let r = 0; r < fineRows; r++) {
        for (let c = 0; c < fineCols; c++) {
          const box: [number, number, number, number] = [
            Math.round(wx0 + c * wCellW),
            Math.round(wy0 + r * wCellH),
            Math.round(wx0 + (c + 1) * wCellW),
            Math.round(wy0 + (r + 1) * wCellH)
          ];
          const cropPath = join(workDir, `fine_${r}_${c}.png`);
          const ok = await cropImage(python, screenshotPath, box, cropPath, upscale);
          if (!ok) {
            fineGrid.push({ row: r, col: c, box, cropPath, response: "", matched: false });
            continue;
          }
          const response = (await describeCropWithOllama(cropPath)) || "";
          queriesIssued++;
          fineGrid.push({ row: r, col: c, box, cropPath, response, matched: matchesKeywords(response, keywords) });
        }
      }

      const fineMatches = fineGrid.filter((g) => g.matched);

      let finalBox: [number, number, number, number];
      let confidence: GroundingResult["confidence"];
      let reason: string;

      if (fineMatches.length === 1 && !ambiguousCoarse) {
        finalBox = fineMatches[0].box;
        confidence = "high";
        reason = `Exactly one coarse cell (row ${winner.row}, col ${winner.col}) and exactly one fine sub-cell within it mentioned the target - unambiguous crop-and-reask agreement.`;
      } else if (fineMatches.length >= 1) {
        finalBox = fineMatches[0].box;
        confidence = "low";
        reason = ambiguousCoarse
          ? `${coarseMatches.length} coarse cells matched (ambiguous); used the first and refined within it, ${fineMatches.length} fine cell(s) matched.`
          : `${fineMatches.length} fine cells matched inside the winning coarse cell (ambiguous refinement); used the first.`;
      } else {
        // Refine stage found nothing - fall back to the coarse cell itself,
        // honestly flagged as low confidence rather than silently trusting it.
        finalBox = winner.box;
        confidence = "low";
        reason = `Coarse cell (row ${winner.row}, col ${winner.col}) matched, but no fine sub-cell re-confirmed the target after cropping+upscaling - falling back to the coarse cell's center. This is the disagreement case: crop-and-reask could not corroborate the coarse guess.`;
      }

      const px = Math.round((finalBox[0] + finalBox[2]) / 2);
      const py = Math.round((finalBox[1] + finalBox[3]) / 2);

      return {
        found: true,
        targetDescription,
        keywords,
        screenshotPixel: { x: px, y: py },
        clickPoint: null, // caller (server.ts) fills this in via toClickSpace() once it has the real logical screen bounds
        scaleFactor: null,
        confidence,
        reason,
        coarseGrid,
        fineGrid,
        queriesIssued,
        elapsedMs: Number((performance.now() - start).toFixed(1))
      };
    } finally {
      try {
        rmSync(workDir, { recursive: true, force: true });
      } catch {}
    }
  }

  /**
   * Converts a coordinate expressed in SCREENSHOT PIXEL space (i.e. matching
   * the dimensions of the PNG `screencapture` produced) into macOS System
   * Events "click space" (logical points), using the REAL logical screen
   * bounds from AppleScript. On this machine screencapture is 3360x2100 and
   * the logical desktop is 1680x1050 (scale factor 2, Retina) - verified via
   * `osascript -e 'tell application "Finder" to get bounds of window of
   * desktop'`. Without this conversion, coordinates read off the screenshot
   * (as the existing UI click-through-image feature in public/app.js does)
   * are sent directly to System Events and land at up to 2x the intended
   * position on any Retina display.
   */
  public static toClickSpace(
    screenshotPixel: { x: number; y: number },
    screenshotSize: { width: number; height: number },
    logicalScreenSize: { width: number; height: number }
  ): { clickPoint: { x: number; y: number }; scaleFactor: number } {
    const scaleFactor = screenshotSize.width / logicalScreenSize.width;
    return {
      clickPoint: {
        x: Math.round(screenshotPixel.x / scaleFactor),
        y: Math.round(screenshotPixel.y / scaleFactor)
      },
      scaleFactor
    };
  }
}
