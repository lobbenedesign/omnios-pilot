/**
 * 🛡️ Human-in-the-Loop Safety Rail & Panic Switch
 * Previews upcoming OS actions, flags dangerous actions (e.g. file deletion, sudo commands),
 * and provides an instantaneous emergency hardware stop.
 */

export interface SafetyCheck {
  isSafe: boolean;
  requiresConfirmation: boolean;
  riskLevel: "none" | "low" | "medium" | "critical";
  reason: string;
}

export class SafetyGuard {
  private isEmergencyStopped: boolean = false;

  public evaluateAction(actionType: string, coords: [number, number], textPayload?: string): SafetyCheck {
    if (this.isEmergencyStopped) {
      return { isSafe: false, requiresConfirmation: true, riskLevel: "critical", reason: "EMERGENCY PANIC SWITCH ENGAGED. All OS actions frozen." };
    }

    if (textPayload && (textPayload.includes("rm -rf") || textPayload.includes("sudo") || textPayload.includes("delete"))) {
      return {
        isSafe: false,
        requiresConfirmation: true,
        riskLevel: "critical",
        reason: "Dangerous deletion or privileged shell command detected. Manual human confirmation required."
      };
    }

    return {
      isSafe: true,
      requiresConfirmation: false,
      riskLevel: "none",
      reason: "Safe non-destructive UI interaction."
    };
  }

  public triggerPanicStop(): { status: string } {
    this.isEmergencyStopped = true;
    return { status: "panic_stop_engaged" };
  }

  public resetSafety(): { status: string } {
    this.isEmergencyStopped = false;
    return { status: "safety_resumed" };
  }
}
