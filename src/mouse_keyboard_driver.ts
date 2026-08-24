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
}
