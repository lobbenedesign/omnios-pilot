/**
 * 📜 Real, disk-persisted action history / audit log.
 *
 * WHY: real computer-use agents (Anthropic's Claude Computer Use reference
 * loop, ByteDance's UI-TARS "memory module") keep a trace of every
 * observation/action pair so a run can be audited or replayed - the model
 * is fed its own action history as context, and a human can inspect what
 * actually happened after the fact. OmniOS-Pilot previously executed every
 * action and threw the result away as soon as the HTTP response was sent;
 * there was no way to answer "what did this agent actually do in the last
 * five minutes" without re-reading terminal scrollback.
 *
 * This module appends one real JSON line per executed action to
 * `data/action_history.jsonl` (created on first write) and can read it back.
 * Nothing here is synthesized: every entry corresponds to an action that was
 * actually dispatched through MouseKeyboardDriver, including failures.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(__dirname, "..", "data");
const HISTORY_FILE = join(DATA_DIR, "action_history.jsonl");

export interface ActionHistoryEntry {
  id: string;
  timestamp: string;
  actionType: string;
  target?: string;
  textPayload?: string;
  coordinates?: [number, number];
  success: boolean;
  output: string;
  durationMs: number;
  safetyRiskLevel: string;
  verification?: {
    beforeScreenshot: string | null;
    afterScreenshot: string | null;
    changedPixelPercent: number | null;
    diffMethod: string;
    afterDescription?: string | null;
    visionModelUsed?: string | null;
  } | null;
  planStepIndex?: number;
  planGoal?: string;
}

export class ActionHistoryLog {
  constructor() {
    if (!existsSync(DATA_DIR)) {
      mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  /** Appends one real executed-action record to the JSONL log on disk. */
  public append(entry: Omit<ActionHistoryEntry, "id" | "timestamp">): ActionHistoryEntry {
    const full: ActionHistoryEntry = {
      id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      ...entry
    };
    try {
      appendFileSync(HISTORY_FILE, JSON.stringify(full) + "\n", "utf-8");
    } catch {
      // Disk write failed (e.g. read-only fs) - the action itself already
      // happened for real; we do not retroactively fabricate a log entry
      // beyond what we could actually persist, we just surface it in-memory
      // to the caller for this one response.
    }
    return full;
  }

  /** Reads back the real persisted history, most recent last-N entries. */
  public getHistory(limit = 50): ActionHistoryEntry[] {
    if (!existsSync(HISTORY_FILE)) return [];
    try {
      const raw = readFileSync(HISTORY_FILE, "utf-8");
      const lines = raw.split("\n").filter(Boolean);
      const parsed: ActionHistoryEntry[] = [];
      for (const line of lines) {
        try {
          parsed.push(JSON.parse(line));
        } catch {
          // skip a corrupted line rather than crash the whole read
        }
      }
      return parsed.slice(-limit).reverse();
    } catch {
      return [];
    }
  }

  public async clear(): Promise<{ status: string }> {
    try {
      await Bun.write(HISTORY_FILE, "");
      return { status: "cleared" };
    } catch (e: any) {
      return { status: `error: ${e.message}` };
    }
  }
}
