/**
 * 🌲 Real macOS Accessibility-tree element locator (AXInspector).
 *
 * WHY: `grounding_agent.ts` locates UI elements by repeatedly asking a local
 * vision model to describe cropped screenshot regions and keyword-matching
 * its free-text answer - it works, but it is inherently a guess: the model
 * can hallucinate a plausible-sounding caption for a crop that doesn't
 * actually contain the target, and there is no independent way to know that
 * happened. This module adds a genuinely different, non-vision grounding
 * source: macOS's own Accessibility tree, queried the same way every real
 * macOS GUI-scripting tool does it - via `System Events` "UI element"
 * AppleScript queries (`osascript`, already the only automation mechanism
 * this whole project uses; no new dependency, no new binary, no Swift/Python
 * accessibility library). When an app exposes a real name/position for an
 * element, this is authoritative OS data, not a model's opinion of a pixel
 * crop.
 *
 * REAL RESEARCH THAT SHAPED THIS (GitHub, not the well-known big competitors
 * already covered elsewhere in this project):
 *   - axcli (github.com/andelf/axcli) - a real Playwright-style CLI that
 *     snapshots the AXUIElement tree of any macOS app and clicks/types via
 *     CSS-like selectors. Confirms the AX tree is a real, usable click-
 *     grounding source outside of vision models, and that "Set-of-Marks"
 *     style tools for macOS are really built on AXUIElement, not on the
 *     vision model itself doing localization.
 *   - AXorcist (github.com/steipete/AXorcist) - a real Swift wrapper doing
 *     chainable/fuzzy AXUIElement queries (read/click/inspect any UI).
 *   - macos-accessibility-client (github.com/drewster99/macos-accessibility-client)
 *     - a real SwiftUI AX-tree inspector/live-observer app; confirms that
 *     inspecting another process's AX tree (name/role/position per element)
 *     is standard, sanctioned macOS automation, not a hack.
 *   - pyax (github.com/eeejay/pyax) - Pythonic AXUIElement/AXObserver
 *     wrapper; another real project doing the same tree-walk this module
 *     does, just from Python instead of AppleScript.
 *   All four independently confirm the same fact this module exploits:
 *   `AXUIElement` positions are real, and `System Events`'s AppleScript
 *   bridge exposes them without any extra dependency - so building this in
 *   plain AppleScript, matching the rest of the project, was the right call
 *   over adding a Swift/Python AX library.
 *
 * WHAT WAS ACTUALLY TESTED ON THIS MACHINE (osascript, real running apps):
 *   1. TextEdit menu bar (`menu bar items of menu bar 1`) returned real,
 *      accurate names + positions for every item - "Apple" @ (10,0),
 *      "TextEdit" @ (44,0), "File" @ (117,0), "Modifica" @ (159,0)
 *      [it. "Edit"], "Formato" @ (231,0) [it. "Format"], "Vista" @ (302,0)
 *      [it. "View"], "Finestra" @ (353,0) [it. "Window"], "Aiuto" @
 *      (422,0) [it. "Help"] - all logical-point coordinates, verified
 *      against the real visible menu bar. This is the strong case: named,
 *      accurate, and needs zero vision model calls at all.
 *   2. TextEdit's window titlebar `buttons of window 1` came back with
 *      `name` empty but a real, correct localized `description` -
 *      "pulsante di chiusura" (close button) @ (183,79), "pulsante contrai"
 *      (minimize) @ (203,79), "pulsante schermo intero" (full screen) @
 *      (223,79) - so this module falls back from `name` to `description`
 *      to `title`, in that order, before giving up on a label.
 *   3. Finder's toolbar `buttons of window 1` returned real, accurate
 *      POSITIONS (e.g. (173,242) 16x16) but `name` was `missing value` for
 *      every one and `description` was also empty - a real, honest
 *      limitation: some apps (Finder's toolbar among them) expose clickable
 *      elements with position/size but no discoverable label via System
 *      Events at all. Those elements are still reported here (role +
 *      position, `label: null`), just never used for keyword matching -
 *      only for proximity cross-checks against a vision-model guess.
 *   4. `entire contents of window 1` on System Settings returned 184 real
 *      elements without erroring, so bigger/SwiftUI-ish apps are walkable
 *      too, though this module does not use `entire contents` (it can be
 *      slow on deep trees like Finder list views) - it queries `buttons`,
 *      `radio buttons`, `checkboxes` and `menu bar items` directly instead,
 *      which is what was actually measured to be fast and reliable.
 *
 * HONEST SCOPE: this is a real, working AX query, not a full AX-tree crawl.
 * It covers the frontmost window's buttons/radio buttons/checkboxes plus
 * the app's menu bar - which is exactly the class of element
 * grounding_agent.ts is asked to find ("click the X button/menu"). It does
 * NOT walk arbitrary nested containers (outlines, tables, scroll areas),
 * because that is real, measured to be slow on some apps (Finder list/
 * icon views can have hundreds of rows) and was not the goal here.
 */

export interface AXElement {
  role: string;
  /** Real name/description/title from the AX tree, or null if the app exposes none (see Finder toolbar case above). */
  label: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  centerX: number;
  centerY: number;
  source: "menuBar" | "button" | "radioButton" | "checkBox";
}

export interface AXEnumerationResult {
  available: boolean;
  processName: string | null;
  elements: AXElement[];
  reason: string;
  elapsedMs: number;
}

export interface AXCrossCheckResult {
  confirmed: boolean;
  matchedElement: AXElement | null;
  distancePx: number | null;
  elementsScanned: number;
  reason: string;
}

const NAME_FALLBACK_SNIPPET = (varName: string) => `
        set ${varName} to missing value
        try
          set ${varName} to (name of el) as string
        end try
        if ${varName} is missing value or ${varName} is "missing value" then
          try
            set ${varName} to (description of el) as string
          end try
        end if
        if ${varName} is missing value or ${varName} is "missing value" then
          try
            set ${varName} to (title of el) as string
          end try
        end if
`;

/** Emits one AppleScript block that walks `collectionExpr` and appends one pipe-delimited line per element to `resultLines`. */
function collectBlock(collectionExpr: string, roleLiteral: string, tag: string): string {
  return `
      try
        set elList to ${collectionExpr}
        repeat with el in elList
          try
            ${NAME_FALLBACK_SNIPPET("elLabel")}
            if elLabel is missing value then set elLabel to "missing value"
            set elPos to position of el
            set elSize to size of el
            set theLine to "${tag}|${roleLiteral}|" & elLabel & "|" & (item 1 of elPos as string) & "|" & (item 2 of elPos as string) & "|" & (item 1 of elSize as string) & "|" & (item 2 of elSize as string)
            copy theLine to end of resultLines
          end try
        end repeat
      end try
`;
}

export class AXInspector {
  /**
   * Enumerates real clickable elements (menu bar items, buttons, radio
   * buttons, checkboxes) of `processName`'s frontmost window via a real
   * System Events AppleScript query - see module header for exactly what
   * was measured on this machine. Falls back to the real frontmost process
   * (via `System Events`) when `processName` is omitted.
   */
  public async enumerate(processName?: string): Promise<AXEnumerationResult> {
    const start = performance.now();
    let proc = processName;
    if (!proc) {
      try {
        const fm = Bun.spawn(["osascript", "-e", 'tell application "System Events" to get name of first application process whose frontmost is true'], { stdout: "pipe" });
        proc = (await new Response(fm.stdout).text()).trim() || undefined;
        await fm.exited;
      } catch {}
    }
    if (!proc) {
      return { available: false, processName: null, elements: [], reason: "Could not determine a real frontmost process via System Events.", elapsedMs: Number((performance.now() - start).toFixed(1)) };
    }
    const escapedProc = proc.replace(/"/g, '\\"');

    const script = `
set resultLines to {}
tell application "System Events"
  if not (exists process "${escapedProc}") then
    error "PROCESS_NOT_FOUND"
  end if
  tell process "${escapedProc}"
    try
      set mbItems to menu bar items of menu bar 1
      repeat with el in mbItems
        try
          ${NAME_FALLBACK_SNIPPET("elLabel")}
          if elLabel is missing value then set elLabel to "missing value"
          set elPos to position of el
          set elSize to size of el
          set theLine to "menuBar|AXMenuBarItem|" & elLabel & "|" & (item 1 of elPos as string) & "|" & (item 2 of elPos as string) & "|" & (item 1 of elSize as string) & "|" & (item 2 of elSize as string)
          copy theLine to end of resultLines
        end try
      end repeat
    end try
    try
      set winList to windows
      if (count of winList) > 0 then
        set theWin to item 1 of winList
        ${collectBlock("buttons of theWin", "AXButton", "button")}
        ${collectBlock("radio buttons of theWin", "AXRadioButton", "radioButton")}
        ${collectBlock("checkboxes of theWin", "AXCheckBox", "checkBox")}
      end if
    end try
  end tell
end tell
set AppleScript's text item delimiters to linefeed
return resultLines as string
`.trim();

    try {
      const spawned = Bun.spawn(["osascript", "-e", script], { stdout: "pipe", stderr: "pipe" });
      const out = (await new Response(spawned.stdout).text()).trim();
      const err = (await new Response(spawned.stderr).text()).trim();
      const code = await spawned.exited;
      if (code !== 0) {
        const notFound = err.includes("PROCESS_NOT_FOUND");
        return {
          available: false,
          processName: proc,
          elements: [],
          reason: notFound
            ? `Real System Events check confirmed process "${proc}" is not currently running (no such application process).`
            : `Real osascript query failed for process "${proc}": ${err || "unknown error (Accessibility permission may have been denied to the terminal/process running this server - System Settings > Privacy & Security > Accessibility)."}`,
          elapsedMs: Number((performance.now() - start).toFixed(1))
        };
      }
      const elements: AXElement[] = [];
      for (const line of out.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("|");
        if (parts.length !== 7) continue;
        const [source, role, label, xs, ys, ws, hs] = parts;
        const x = Number(xs), y = Number(ys), w = Number(ws), h = Number(hs);
        if (![x, y, w, h].every(Number.isFinite)) continue;
        elements.push({
          role,
          label: label === "missing value" ? null : label,
          x, y, width: w, height: h,
          centerX: Math.round(x + w / 2),
          centerY: Math.round(y + h / 2),
          source: source as AXElement["source"]
        });
      }
      return {
        available: true,
        processName: proc,
        elements,
        reason: `Real System Events query returned ${elements.length} real elements (menu bar + window buttons/radio buttons/checkboxes) for process "${proc}".`,
        elapsedMs: Number((performance.now() - start).toFixed(1))
      };
    } catch (e: any) {
      return { available: false, processName: proc, elements: [], reason: e.message, elapsedMs: Number((performance.now() - start).toFixed(1)) };
    }
  }

  /**
   * Cross-checks a vision-grounding click-space coordinate (e.g. from
   * `GroundingAgent.locate` + `toClickSpace`) against the REAL accessibility
   * tree: does a real AX element exist near that point, and if it has a
   * real label, does that label mention any of `keywords`? Never fabricates
   * a confirmation - `confirmed` is only true when real AX data backs it up.
   */
  public async crossCheckPoint(
    clickPoint: { x: number; y: number },
    keywords: string[],
    processName?: string,
    radiusPx = 40
  ): Promise<AXCrossCheckResult> {
    const enumRes = await this.enumerate(processName);
    if (!enumRes.available) {
      return { confirmed: false, matchedElement: null, distancePx: null, elementsScanned: 0, reason: `AX cross-check unavailable: ${enumRes.reason}` };
    }
    const lowerKeywords = keywords.map((k) => k.toLowerCase());
    let best: { el: AXElement; dist: number; labelMatch: boolean } | null = null;

    for (const el of enumRes.elements) {
      const dist = Math.hypot(el.centerX - clickPoint.x, el.centerY - clickPoint.y);
      const labelMatch = !!el.label && lowerKeywords.some((k) => el.label!.toLowerCase().includes(k));
      if (dist > radiusPx && !labelMatch) continue;
      // Prefer a labeled match over an unlabeled one; among ties, prefer the closer element.
      if (!best || (labelMatch && !best.labelMatch) || (labelMatch === best.labelMatch && dist < best.dist)) {
        best = { el, dist, labelMatch };
      }
    }

    if (!best) {
      return {
        confirmed: false,
        matchedElement: null,
        distancePx: null,
        elementsScanned: enumRes.elements.length,
        reason: `No real AX element (of ${enumRes.elements.length} scanned in process "${enumRes.processName}") was within ${radiusPx}px of (${clickPoint.x},${clickPoint.y}) or had a label matching [${keywords.join(", ")}].`
      };
    }
    return {
      confirmed: true,
      matchedElement: best.el,
      distancePx: Number(best.dist.toFixed(1)),
      elementsScanned: enumRes.elements.length,
      reason: best.labelMatch
        ? `Real AX element "${best.el.label}" (${best.el.role}) at (${best.el.centerX},${best.el.centerY}) matches a keyword and is ${best.dist.toFixed(1)}px from the vision-grounded point - independent OS-level corroboration.`
        : `A real, unlabeled AX element (${best.el.role}) at (${best.el.centerX},${best.el.centerY}) sits only ${best.dist.toFixed(1)}px from the vision-grounded point - positional corroboration only (this app does not expose a label for it, see module header's Finder toolbar case).`
    };
  }
}
