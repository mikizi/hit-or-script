/**
 * Map common English country names (as stored on tracks) to ISO 3166-1 alpha-2.
 * Extend when you add more `country` fields on tracks.
 */
const COUNTRY_NAME_TO_CC: Record<string, string> = {
  australia: "AU",
  cyprus: "CY",
  italy: "IT",
  portugal: "PT",
  croatia: "HR",
  wales: "GB",
  greece: "GR",
  malta: "MT",
  sweden: "SE",
  norway: "NO",
  denmark: "DK",
  finland: "FI",
  iceland: "IS",
  ireland: "IE",
  "united kingdom": "GB",
  uk: "GB",
  france: "FR",
  germany: "DE",
  spain: "ES",
  netherlands: "NL",
  belgium: "BE",
  switzerland: "CH",
  austria: "AT",
  poland: "PL",
  ukraine: "UA",
  russia: "RU",
  turkey: "TR",
  israel: "IL",
  moldova: "MD",
  romania: "RO",
  armenia: "AM",
  azerbaijan: "AZ",
  serbia: "RS",
  slovenia: "SI",
  "bosnia & herzegovina": "BA",
  "bosnia and herzegovina": "BA",
  estonia: "EE",
  latvia: "LV",
  lithuania: "LT",
  albania: "AL",
  montenegro: "ME",
  "north macedonia": "MK",
  macedonia: "MK",
  bulgaria: "BG",
  hungary: "HU",
  czechia: "CZ",
  slovakia: "SK",
  georgia: "GE",
};

/** Two regional indicator letters → one flag emoji. */
export function flagFromAlpha2(code: string): string | null {
  const cc = code.trim().toUpperCase();
  if (cc.length !== 2 || !/^[A-Z]{2}$/.test(cc)) return null;
  const A = 0x41;
  const base = 0x1f1e6;
  return String.fromCodePoint(
    base + (cc.charCodeAt(0) - A),
    base + (cc.charCodeAt(1) - A),
  );
}

/** First regional-indicator pair in the string (e.g. titles like "… | Sweden 🇸🇪 | …"). */
export function extractFlagFromText(text: string): string | null {
  const m = text.match(/\p{Regional_Indicator}{2}/u);
  return m ? m[0]! : null;
}

/**
 * Best-effort flag for the reveal header: explicit `country` on the track, else emoji in the title.
 */
export function resolveTrackFlagEmoji(
  country: string | undefined,
  title: string | undefined,
): string {
  if (country) {
    const key = country.trim().toLowerCase();
    const cc = COUNTRY_NAME_TO_CC[key];
    if (cc) {
      const fromCc = flagFromAlpha2(cc);
      if (fromCc) return fromCc;
    }
  }
  if (title) {
    const fromTitle = extractFlagFromText(title);
    if (fromTitle) return fromTitle;
  }
  return "";
}

/** ISO alpha-2 codes used to build the scoreboard flag picker (deduped → emoji). */
const SCOREBOARD_PICKER_CODES: readonly string[] = [
  "SE",
  "NO",
  "FI",
  "DK",
  "IS",
  "IE",
  "GB",
  "FR",
  "DE",
  "ES",
  "IT",
  "NL",
  "BE",
  "CH",
  "AT",
  "PL",
  "UA",
  "IL",
  "GR",
  "CY",
  "MT",
  "PT",
  "HR",
  "RS",
  "SI",
  "RO",
  "MD",
  "AM",
  "AZ",
  "GE",
  "EE",
  "LV",
  "LT",
  "AL",
  "ME",
  "MK",
  "BG",
  "HU",
  "CZ",
  "SK",
  "AU",
  "TR",
  "LU",
  "BA",
] as const;

const SCOREBOARD_PICKER_EXTRAS: readonly string[] = ["🎤", "⭐", "💖", "🏳️‍🌈"];

/** Flag and symbol emojis offered when saving a scoreboard run. */
export const SCOREBOARD_PICKER_FLAG_EMOJIS: readonly string[] = (() => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const code of SCOREBOARD_PICKER_CODES) {
    const e = flagFromAlpha2(code);
    if (e && !seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  for (const e of SCOREBOARD_PICKER_EXTRAS) {
    if (!seen.has(e)) {
      seen.add(e);
      out.push(e);
    }
  }
  return out;
})();
