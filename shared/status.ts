/**
 * Pure helpers for the AgentCard fields on a peer:
 *   - PeerStatus enum validator
 *   - TaskState enum validator
 *   - skills JSON encode/decode round-trip
 *
 * No I/O. Co-located unit tests live in `status.test.ts`.
 */

import { PEER_STATUSES, TASK_STATES, type PeerStatus, type TaskState } from "./types.ts";

export function isPeerStatus(v: unknown): v is PeerStatus {
  return typeof v === "string" && (PEER_STATUSES as readonly string[]).includes(v);
}

export function isTaskState(v: unknown): v is TaskState {
  return typeof v === "string" && (TASK_STATES as readonly string[]).includes(v);
}

/**
 * `skills` is stored as a JSON-encoded string in SQLite (`'["rust","sql"]'`) so
 * the column stays a simple TEXT and matching can use SQLite's `json_each`.
 *
 * `serializeSkills(null)` returns `null` — preserves the "no skills declared"
 * state distinctly from `[]` ("declared zero skills"). Callers that pass an
 * input that isn't an array of strings get `null` back; broker-side validation
 * is responsible for rejecting bad input before this is called.
 */
export function serializeSkills(skills: string[] | null | undefined): string | null {
  if (skills === null || skills === undefined) return null;
  if (!Array.isArray(skills)) return null;
  if (!skills.every((s) => typeof s === "string")) return null;
  return JSON.stringify(skills);
}

/**
 * Inverse of `serializeSkills`. Returns `null` for NULL/undefined input and
 * for malformed JSON (defensive — old rows or corrupt DB shouldn't crash the
 * broker). A successfully-parsed non-array also returns `null`.
 */
export function parseSkills(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    if (!parsed.every((s) => typeof s === "string")) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * True iff `skills` is an array of strings (or null). Used by request
 * validators on /set-status and /register to reject bad shapes early with
 * a 400 instead of silently dropping the field via serializeSkills.
 */
export function isValidSkillsInput(v: unknown): v is string[] | null {
  if (v === null) return true;
  if (!Array.isArray(v)) return false;
  return v.every((s) => typeof s === "string");
}
