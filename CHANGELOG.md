# Changelog

All entries describe what was genuinely verified in this environment, not aspirational claims. See `README.md`'s "Honesty note" for the full history of what was previously fabricated and removed.

## Unreleased — real pixel-coordinate click dispatch

**Gap identified:** the README explicitly stated "Real mouse click-at-coordinates is not implemented" — a capability that real competitors (Anthropic's Claude Computer Use, OpenAI's Computer Use/Operator, bytedance/UI-TARS) all ship as a core primitive.

**What was built:**
- `MouseKeyboardDriver.clickAt(x, y, processName?)` and `doubleClickAt(...)` in `src/mouse_keyboard_driver.ts`, dispatching real macOS mouse clicks at absolute screen coordinates via `osascript -e 'tell application "System Events" to tell process "<name>" to click at {x, y}'`.
- `MouseKeyboardDriver.pressKeyCode(keyCode, modifiers?)` for real keyboard-shortcut dispatch (e.g. Cmd+C) via System Events `key code ... using {command down}`, as opposed to the plain-text `keystroke` used by the pre-existing `typeText`.
- New server endpoints in `server.ts`: `POST /api/pilot/click`, `POST /api/pilot/keycode`, and `actionType: "click" | "double_click"` support on the existing `POST /api/pilot/execute`. All coordinate-bearing actions now pass real `[x, y]` into `SafetyGuard.evaluateAction` instead of the previous hardcoded `[0, 0]`.
- Frontend: clicking directly on the rendered screenshot in the dashboard (`public/app.js`, `setupCanvasClickToRealClick`) now maps the click position back to real absolute screen coordinates (using the actual scale/offset the screenshot image was drawn at) and dispatches a genuine `POST /api/pilot/click` — closing a manual observe → click → re-observe loop that did not exist before.

**How it was verified:**
1. `bun build server.ts --target=bun --outfile=/dev/null` — compiles clean.
2. `node -c public/app.js` — valid syntax.
3. Discovered through direct experimentation that `click at {x,y}` sent to the bare `System Events` application object fails with AppleScript error `-609` ("invalid connection"); `sdef /System/Library/CoreServices/System\ Events.app` confirmed the `at` parameter belongs to the `process` AppleScript class, not `application`. Fixed by targeting a named process (`tell process "Finder" to click at {x,y}`), confirmed with a bare `osascript` call (exit code 0).
4. Started the real server (`bun server.ts`) and exercised the new endpoints with `curl`:
   - `POST /api/pilot/click {"x":300,"y":300,"process":"Finder"}` → `"success":true`, `"output":"Real click dispatched to process \"Finder\" at (300, 300)"`.
   - `POST /api/pilot/click {..., "double":true}` → real double-click, `"success":true`.
   - `POST /api/pilot/keycode {"keyCode":53}` (Escape) → `"success":true`.
   - `POST /api/pilot/execute {"actionType":"click", ...}` → routes through to the same real driver call.
   - Regression check: `POST /api/pilot/execute` with a `sudo rm -rf /` payload still returns `403` — the safety guard was not weakened by this change.
   - Negative-case check: `POST /api/pilot/click` targeting a nonexistent process (`"ThisAppDoesNotExist123"`) returns `"success":false` with an honest empty/error output — not a faked success.

**What is still explicitly NOT claimed:** no model decides *where* to click. The coordinate is supplied by the human (clicking the on-screen screenshot) or by an API caller. There is still no autonomous "observe → decide → click → re-observe" loop running without a human or external driver in it. See the updated README "What this project still does NOT do" sections (English and Italian) for the full, current honesty note.
