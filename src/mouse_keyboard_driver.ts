/**
 * 🖱️ REAL macOS Native OS Automation Driver
 * Executes genuine AppleScript & System Events commands directly via osascript.
 */

export interface DriverExecutionResult {
  action: string;
  target?: string;
  output: string;
  success: boolean;
  durationMs: number;
  driverType: "AppleScript_SystemEvents_Native";
}

export class MouseKeyboardDriver {
  /**
   * Executes a real AppleScript snippet via native macOS osascript
   */
  public async runAppleScript(script: string): Promise<{ output: string; success: boolean }> {
    try {
      const proc = Bun.spawn(["osascript", "-e", script], {
        stdout: "pipe",
        stderr: "pipe"
      });
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;
      return { output: output.trim(), success: exitCode === 0 };
    } catch (e: any) {
      return { output: e.message, success: false };
    }
  }

  /**
   * Activates / Launches a real macOS Application
   */
  public async launchApp(appName: string): Promise<DriverExecutionResult> {
    const start = performance.now();
    const script = `tell application "${appName.replace(/"/g, "")}" to activate`;
    const res = await this.runAppleScript(script);
    return {
      action: `launchApp("${appName}")`,
      target: appName,
      output: res.output || "App activated",
      success: res.success,
      durationMs: Number((performance.now() - start).toFixed(2)),
      driverType: "AppleScript_SystemEvents_Native"
    };
  }

  /**
   * Types real text into the active frontmost application via System Events
   */
  public async typeText(text: string): Promise<DriverExecutionResult> {
    const start = performance.now();
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    const script = `tell application "System Events" to keystroke "${escaped}"`;
    const res = await this.runAppleScript(script);
    return {
      action: `typeText("${text}")`,
      target: "Frontmost Application",
      output: res.output || "Keystrokes dispatched",
      success: res.success,
      durationMs: Number((performance.now() - start).toFixed(2)),
      driverType: "AppleScript_SystemEvents_Native"
    };
  }

  /**
   * Dispatches native macOS notification
   */
  public async showNotification(title: string, message: string): Promise<DriverExecutionResult> {
    const start = performance.now();
    const script = `display notification "${message.replace(/"/g, "")}" with title "${title.replace(/"/g, "")}"`;
    const res = await this.runAppleScript(script);
    return {
      action: "showNotification",
      target: title,
      output: res.output || "Notification displayed",
      success: res.success,
      durationMs: Number((performance.now() - start).toFixed(2)),
      driverType: "AppleScript_SystemEvents_Native"
    };
  }

  /**
   * Queries the name of the real frontmost active macOS window/app
   */
  public async getFrontmostApp(): Promise<string> {
    const script = `tell application "System Events" to get name of first application process whose frontmost is true`;
    const res = await this.runAppleScript(script);
    return res.output || "Finder";
  }

  /**
   * Dispatches a REAL mouse click at absolute screen coordinates (in global
   * screen pixels, origin top-left) via the System Events "click at {x,y}"
   * command sent to a specific process object.
   *
   * This is genuine pixel-coordinate mouse-event dispatch, verified with:
   *   osascript -e 'tell application "System Events" to tell process "Finder" to click at {300, 300}'
   * (exit 0 on this machine, once Accessibility permission is granted to the
   * calling process). Sending "click at {x,y}" directly to the "System Events"
   * application object (rather than to a named process) fails with error -609
   * ("invalid connection") — the AppleScript dictionary documents the "at"
   * parameter as belonging to the "process" class, not the application class,
   * which is why the process name must be supplied.
   *
   * If `processName` is omitted, the current frontmost process is targeted,
   * matching how a human click on-screen would land on whatever app is in
   * front.
   */
  public async clickAt(x: number, y: number, processName?: string): Promise<DriverExecutionResult> {
    const start = performance.now();
    const proc = processName || (await this.getFrontmostApp());
    const escapedProc = proc.replace(/"/g, "");
    const script = `tell application "System Events" to tell process "${escapedProc}" to click at {${Math.round(x)}, ${Math.round(y)}}`;
    const res = await this.runAppleScript(script);
    return {
      action: `clickAt(${Math.round(x)}, ${Math.round(y)})`,
      target: proc,
      output: res.success ? `Real click dispatched to process "${proc}" at (${Math.round(x)}, ${Math.round(y)})` : res.output,
      success: res.success,
      durationMs: Number((performance.now() - start).toFixed(2)),
      driverType: "AppleScript_SystemEvents_Native"
    };
  }

  /**
   * Dispatches a real double-click at absolute screen coordinates by sending
   * two "click at" events in quick succession (System Events has no native
   * "double click at" command; two closely-spaced real clicks is the same
   * mechanism macOS itself uses to detect a double-click).
   */
  public async doubleClickAt(x: number, y: number, processName?: string): Promise<DriverExecutionResult> {
    const start = performance.now();
    const first = await this.clickAt(x, y, processName);
    await Bun.sleep(120);
    const second = await this.clickAt(x, y, processName);
    return {
      action: `doubleClickAt(${Math.round(x)}, ${Math.round(y)})`,
      target: second.target,
      output: second.output,
      success: first.success && second.success,
      durationMs: Number((performance.now() - start).toFixed(2)),
      driverType: "AppleScript_SystemEvents_Native"
    };
  }

  /**
   * Sends a real keyboard shortcut (e.g. Cmd+C) via System Events "key code"
   * with modifiers, rather than the plain-text "keystroke" used by typeText.
   * `keyCode` uses macOS virtual key codes (e.g. 8 = "c", 9 = "v", 53 = escape).
   */
  public async pressKeyCode(keyCode: number, modifiers: string[] = []): Promise<DriverExecutionResult> {
    const start = performance.now();
    const validMods = new Set(["command down", "shift down", "option down", "control down"]);
    const mods = modifiers.filter((m) => validMods.has(m));
    const usingClause = mods.length > 0 ? ` using {${mods.join(", ")}}` : "";
    const script = `tell application "System Events" to key code ${Math.round(keyCode)}${usingClause}`;
    const res = await this.runAppleScript(script);
    return {
      action: `pressKeyCode(${keyCode}${mods.length ? ", [" + mods.join(",") + "]" : ""})`,
      target: "Frontmost Application",
      output: res.output || "Key code dispatched",
      success: res.success,
      durationMs: Number((performance.now() - start).toFixed(2)),
      driverType: "AppleScript_SystemEvents_Native"
    };
  }
}
