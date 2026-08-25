/**
 * 📊 Qualitative Feature Comparison vs other OS/desktop automation projects.
 *
 * HONESTY NOTE: an earlier version of this file hardcoded a fake
 * "coordinateGroundingAccuracy" percentage for every project (97.4% for
 * OmniOS-Pilot, 96.1% for UI-TARS, 91.8% for Claude Computer Use, etc.) and a
 * "sub-10ms" latency claim. None of those numbers were ever measured -
 * OmniOS-Pilot has never been benchmarked against any of these projects on
 * any dataset (e.g. OSWorld, ScreenSpot), and no pixel-coordinate grounding
 * model is even part of this codebase (see src/vision_agent.ts). Those
 * figures have been removed. This is now a plain, unscored feature
 * comparison based on public documentation of each project, marked as such.
 */

export interface OSCopilotCompetitor {
  name: string;
  architecture: "Native macOS Agent (this project)" | "VLM GUI Framework" | "Cloud Docker Container" | "Academic Benchmark";
  pixelCoordinateGrounding: "Not implemented" | "Yes (published)" | "Unknown";
  humanInTheLoopSafety: boolean;
  visualBBoxOverlay: boolean;
  localOfflinePrivacy: boolean;
  notes: string;
}

export class OSCompetitorBenchmark {
  public getComparison(): OSCopilotCompetitor[] {
    return [
      {
        name: "🖥️ OmniOS-Pilot (this project)",
        architecture: "Native macOS Agent (this project)",
        pixelCoordinateGrounding: "Not implemented",
        humanInTheLoopSafety: true,
        visualBBoxOverlay: false,
        localOfflinePrivacy: true,
        notes: "Real AppleScript/System Events driver, real screen capture, real process enumeration, optional local Ollama (moondream) scene description. No pixel-click grounding model; goal→action mapping is keyword heuristics."
      },
      {
        name: "ByteDance UI-TARS",
        architecture: "VLM GUI Framework",
        pixelCoordinateGrounding: "Yes (published)",
        humanInTheLoopSafety: false,
        visualBBoxOverlay: false,
        localOfflinePrivacy: true,
        notes: "Published research project with its own reported ScreenSpot/OSWorld numbers; not reproduced or verified here."
      },
      {
        name: "Anthropic Claude Computer Use",
        architecture: "Cloud Docker Container",
        pixelCoordinateGrounding: "Yes (published)",
        humanInTheLoopSafety: true,
        visualBBoxOverlay: false,
        localOfflinePrivacy: false,
        notes: "Runs in a sandboxed container via the Anthropic API; billed per API usage."
      },
      {
        name: "ShowUI (ShowLab)",
        architecture: "VLM GUI Framework",
        pixelCoordinateGrounding: "Yes (published)",
        humanInTheLoopSafety: false,
        visualBBoxOverlay: true,
        localOfflinePrivacy: true,
        notes: "Open research project; see its own repository for reported numbers."
      },
      {
        name: "OS-World / OS-Copilot",
        architecture: "Academic Benchmark",
        pixelCoordinateGrounding: "Unknown",
        humanInTheLoopSafety: false,
        visualBBoxOverlay: false,
        localOfflinePrivacy: true,
        notes: "OSWorld is primarily an evaluation benchmark, not itself a shipping agent."
      }
    ];
  }
}
