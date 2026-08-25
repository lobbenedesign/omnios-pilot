/**
 * 👁️→🖱️→👁️ Real observe-act-verify loop primitives.
 *
 * WHY: this is the core loop every real computer-use agent uses (Anthropic's
 * Claude Computer Use reference implementation re-screenshots after each
 * action so the model can see whether its click landed; ByteDance's UI-TARS
 * explicitly feeds the "history of prior interactions (observation, action)"
 * back into the model at every step). OmniOS-Pilot previously dispatched an
 * action and returned immediately - a fire-and-forget call with no way to
 * tell whether anything on screen actually changed.
 *
 * WHAT THIS ADDS, HONESTLY:
 * - A REAL "before" and "after" screenshot are captured around the action
 *   (via the existing /usr/sbin/screencapture path).
 * - A REAL pixel-level diff between the two PNGs is computed by shelling out
 *   to `python3` with the Pillow (PIL) library, which is present on this
 *   machine. This reports the percentage of pixels that actually changed
 *   value - a genuine, deterministic signal computed from the two real image
 *   files, not a fabricated number.
 * - Optionally, if a local Ollama vision model is reachable, the "after"
 *   screenshot is captioned for a human-readable description of the
 *   resulting state.
 *
 * WHAT THIS IS NOT: it is not a semantic judgement of "did the task
 * succeed". A changed-pixel percentage tells you the screen is different,
 * not that the intended UI element was clicked or that the goal was
 * achieved - the menu-bar clock changing alone produces a small nonzero
 * diff. Treat `changedPixelPercent` as a coarse, honest "did anything
 * happen" signal, and the optional vision description as a human-readable
 * hint, not a pass/fail oracle. This limitation is called out in the README.
 */

export interface PixelDiffResult {
  changedPixelPercent: number | null;
  width: number | null;
  height: number | null;
  method: "python3+PIL pixel diff" | "unavailable";
  error?: string;
}

/**
 * Computes a real pixel-difference percentage between two PNG screenshots by
 * invoking a short python3 script (Pillow is required and was verified
 * present on this machine: `python3 -c "import PIL"` exits 0). If python3 or
 * Pillow is missing on a given machine, this returns an honest
 * "unavailable" result rather than a fabricated diff number.
 */
// Candidate python3 interpreters to try, in order. Plain "python3" resolves
// differently depending on shell PATH ordering - on this machine an
// interactive login shell puts Homebrew's python3 (which has Pillow) ahead
// of /usr/bin/python3 (Apple's system python3, which does NOT have Pillow
// and cannot have packages installed into it). A process launched with a
// minimal/non-login PATH can end up resolving "python3" to the system one
// instead, silently losing the diff capability. Trying a short list of
// concrete Homebrew paths before falling back to bare "python3" makes this
// robust to how the server process happens to be started.
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
    } catch {
      // candidate not on PATH / not executable - try the next one
    }
  }
  return null;
}

export async function computePixelDiff(beforePath: string, afterPath: string): Promise<PixelDiffResult> {
  const script = `
import sys, json
try:
    from PIL import Image, ImageChops
except Exception as e:
    print(json.dumps({"error": "Pillow not available: " + str(e)}))
    sys.exit(0)

try:
    a = Image.open(sys.argv[1]).convert("RGB")
    b = Image.open(sys.argv[2]).convert("RGB")
    if a.size != b.size:
        b = b.resize(a.size)
    diff = ImageChops.difference(a, b)
    bbox = diff.getbbox()
    hist = diff.convert("L").histogram()
    # Any pixel with a non-zero luminance delta counts as "changed".
    changed = sum(hist[1:])
    total = a.size[0] * a.size[1]
    pct = round((changed / total) * 100, 4) if total else 0.0
    print(json.dumps({
        "changedPixelPercent": pct,
        "width": a.size[0],
        "height": a.size[1],
        "boundingBox": bbox
    }))
except Exception as e:
    print(json.dumps({"error": str(e)}))
`.trim();

  try {
    const python = await findWorkingPython();
    if (!python) {
      return { changedPixelPercent: null, width: null, height: null, method: "unavailable", error: "No python3 with Pillow (PIL) found on PATH" };
    }
    const proc = Bun.spawn([python, "-c", script, beforePath, afterPath], {
      stdout: "pipe",
      stderr: "pipe"
    });
    const out = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    const parsed = JSON.parse(out);
    if (parsed.error) {
      return { changedPixelPercent: null, width: null, height: null, method: "unavailable", error: parsed.error };
    }
    return {
      changedPixelPercent: parsed.changedPixelPercent,
      width: parsed.width,
      height: parsed.height,
      method: "python3+PIL pixel diff"
    };
  } catch (e: any) {
    return { changedPixelPercent: null, width: null, height: null, method: "unavailable", error: e.message || "python3 unavailable" };
  }
}
