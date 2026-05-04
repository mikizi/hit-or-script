/** Real Eurovision vs AI / fan “AIROVISION” style entry. */
export type TrackKind = "hit" | "script";

export interface Track {
  id: string;
  kind: TrackKind;
  youtubeUrl: string;
  /** Kept for data / generators; in-game `script` uses a random 10–30s start, `hit` uses 60–120s. */
  clipStartSec: number;
  /**
   * Whole **seconds** (not ms): parsed from YouTube Data API `contentDetails.duration` (ISO 8601, e.g. PT3M50S → 230).
   * When set, the game caps the random clip start so ~20s of playable audio remains before the video ends.
   */
  youtubeDurationSec?: number;
  title?: string;
  artist?: string;
  country?: string;
  year?: number;
  story?: string;
  revealNote?: string;
}

/** Serialized into the game iframe for client-side logic. */
export interface TrackPayload {
  kind: TrackKind;
  videoId: string;
  /** Carried from `Track`; clip start is chosen per round in the game (script: 10–30s, hit: 60–120s). */
  clipStartSec: number;
  youtubeUrl: string;
  youtubeDurationSec?: number;
  title?: string;
  artist?: string;
  country?: string;
  year?: number;
  story?: string;
  revealNote?: string;
}
