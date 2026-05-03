/**
 * Optional global leaderboard via Supabase PostgREST (free tier, no extra npm deps).
 *
 * 1. Create a project at https://supabase.com
 * 2. Run SQL from `supabase/leaderboard.sql` in the SQL editor
 * 3. Set `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `.env` (local) and GitHub Actions secrets (Pages build)
 */

import type { ScoreboardEntry } from "./scoreboard";
import { SCOREBOARD_MAX_ENTRIES } from "./scoreboard";

const TABLE = "leaderboard_entries";

/** Max total points for a single game (3 rounds × 100). */
const MAX_GAME_SCORE = 300;

function supabaseUrl(): string {
  return String(import.meta.env.VITE_SUPABASE_URL ?? "").trim().replace(/\/$/, "");
}

function supabaseAnonKey(): string {
  return String(import.meta.env.VITE_SUPABASE_ANON_KEY ?? "").trim();
}

export function isGlobalLeaderboardConfigured(): boolean {
  return Boolean(supabaseUrl() && supabaseAnonKey());
}

function authHeaders(): Record<string, string> {
  const key = supabaseAnonKey();
  return {
    apikey: key,
    Authorization: "Bearer " + key,
  };
}

function mapRow(row: Record<string, unknown>): ScoreboardEntry | null {
  if (
    typeof row.id !== "string" ||
    typeof row.label !== "string" ||
    typeof row.score !== "number" ||
    typeof row.max_possible !== "number" ||
    typeof row.created_at !== "string"
  ) {
    return null;
  }
  const flag = row.flag;
  return {
    id: row.id,
    label: row.label,
    score: row.score,
    maxPossible: row.max_possible,
    createdAt: row.created_at,
    flag: typeof flag === "string" ? flag : undefined,
  };
}

/**
 * Fetch top rows for the scoreboard UI (same cap as local storage).
 */
export async function fetchGlobalLeaderboard(): Promise<ScoreboardEntry[]> {
  const base = supabaseUrl();
  const key = supabaseAnonKey();
  const q =
    "select=id,label,score,max_possible,flag,created_at" +
    "&order=score.desc,created_at.desc" +
    "&limit=" +
    String(SCOREBOARD_MAX_ENTRIES);
  const url = base + "/rest/v1/" + TABLE + "?" + q;
  const res = await fetch(url, {
    method: "GET",
    headers: {
      ...authHeaders(),
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("Leaderboard request failed (" + String(res.status) + "): " + text.slice(0, 200));
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) return [];
  const out: ScoreboardEntry[] = [];
  for (const row of data) {
    if (row !== null && typeof row === "object") {
      const e = mapRow(row as Record<string, unknown>);
      if (e) out.push(e);
    }
  }
  return out;
}

export interface GlobalLeaderboardInsert {
  label: string;
  score: number;
  maxPossible: number;
  flag: string;
}

/**
 * Insert one run into Supabase (public anon insert; bounded by RLS on the server).
 */
export async function insertGlobalLeaderboardEntry(params: GlobalLeaderboardInsert): Promise<void> {
  const base = supabaseUrl();
  const label = params.label.trim().slice(0, 40);
  const flag = params.flag.trim().slice(0, 16);
  if (!label) throw new Error("Scoreboard name is required");
  if (!flag) throw new Error("Scoreboard flag is required");
  if (params.score < 0 || params.score > MAX_GAME_SCORE) {
    throw new Error("Invalid score");
  }
  if (params.maxPossible < 1 || params.maxPossible > MAX_GAME_SCORE) {
    throw new Error("Invalid max score");
  }
  const url = base + "/rest/v1/" + TABLE;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      label,
      score: params.score,
      max_possible: params.maxPossible,
      flag,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error("Could not save to global leaderboard (" + String(res.status) + "). " + text.slice(0, 160));
  }
}
