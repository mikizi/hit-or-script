/**
 * Eurovision-style point ladder (no 9 or 11 — same as classic televote/jury “douze points” steps).
 */
export const EUROVISION_POINT_LADDER = [12, 10, 8, 7, 6, 5, 4, 3, 2, 1] as const;

export type EurovisionLadderValue = (typeof EUROVISION_POINT_LADDER)[number];

/** Badge number for sorted rank #1 → 12, #2 → 10, … (then 1 for overflow). */
export function ladderBadgeForPlace(placeIndex: number): EurovisionLadderValue {
  if (placeIndex >= 0 && placeIndex < EUROVISION_POINT_LADDER.length) {
    return EUROVISION_POINT_LADDER[placeIndex]!;
  }
  return 1;
}

export interface ScoreboardEntry {
  id: string;
  label: string;
  score: number;
  maxPossible: number;
  createdAt: string;
  /** Flag emoji chosen when saving (older rows may omit). */
  flag?: string;
}

const STORAGE_KEY = "hit-or-script-scoreboard-v1";

/** Max rows kept after each save (sorted by score). */
export const SCOREBOARD_MAX_ENTRIES = 40;

function safeParse(raw: string | null): ScoreboardEntry[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw) as unknown;
    if (!Array.isArray(data)) return [];
    return data.filter(isValidEntry);
  } catch {
    return [];
  }
}

function isValidEntry(x: unknown): x is ScoreboardEntry {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    typeof o.label === "string" &&
    typeof o.score === "number" &&
    typeof o.maxPossible === "number" &&
    typeof o.createdAt === "string" &&
    (o.flag === undefined || typeof o.flag === "string")
  );
}

export function loadScoreboard(): ScoreboardEntry[] {
  return safeParse(localStorage.getItem(STORAGE_KEY));
}

export function saveScoreboard(entries: ScoreboardEntry[]): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(entries.slice(0, SCOREBOARD_MAX_ENTRIES)),
  );
}

const GHOST_ID = "__scoreboard-qualify-check__";

/**
 * Whether a finished run with `score` would still appear after save (top {@link SCOREBOARD_MAX_ENTRIES} by score).
 */
export function runQualifiesForScoreboard(score: number): boolean {
  const entries = loadScoreboard();
  if (entries.length < SCOREBOARD_MAX_ENTRIES) return true;
  const ghost: ScoreboardEntry = {
    id: GHOST_ID,
    label: "",
    score,
    maxPossible: 0,
    createdAt: new Date().toISOString(),
  };
  const next = [...entries, ghost].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  const idx = next.findIndex((e) => e.id === GHOST_ID);
  return idx >= 0 && idx < SCOREBOARD_MAX_ENTRIES;
}

export function addScoreboardEntry(
  label: string,
  score: number,
  maxPossible: number,
  flagEmoji: string,
): ScoreboardEntry {
  const trimmed = label.trim();
  if (!trimmed) {
    throw new Error("Scoreboard name is required");
  }
  const flag = flagEmoji.trim();
  if (!flag) {
    throw new Error("Scoreboard flag is required");
  }
  const entry: ScoreboardEntry = {
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : "id-" + String(Date.now()) + "-" + String(Math.random()).slice(2, 9),
    label: trimmed,
    score,
    maxPossible,
    flag,
    createdAt: new Date().toISOString(),
  };
  const next = [...loadScoreboard(), entry];
  next.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });
  saveScoreboard(next);
  return entry;
}
