/**
 * Pull video metadata for two sides (real “hit” vs fan/AI “script”) via the official
 * YouTube Data API v3 — no page scraping.
 *
 * Setup:
 * 1. Google Cloud Console → enable "YouTube Data API v3" → create an API key.
 * 2. Copy .env.example to .env and set YOUTUBE_API_KEY (loaded automatically by youtube:pull).
 *    Or: export YOUTUBE_API_KEY=...
 * 3. youtube-sync.config.json — each of `hit` / `script` can be:
 *    - channel: `channelId` ("UC…") and/or `handle` (no @) → channel uploads
 *    - `searchQuery` → YouTube search (dynamic)
 *    - `playlistId` ("PL…") → playlist order
 * 4. npm run youtube:pull — add `-- --write` for src/generated/tracksFromYoutube.ts (writes `youtubeDurationSec` + safe `clipStartSec`)
 *
 * Quota: channel ≈ channels + playlistItems; search uses search.list (higher cost per 100 results).
 * After listing videos, `videos.list` (contentDetails) runs in batches of 50 ids (~1 quota unit per batch).
 */
import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Track, TrackKind } from "../types/track.js";

const API = "https://www.googleapis.com/youtube/v3";

type ChannelRef = {
  channelId?: string;
  handle?: string;
};

/** One of: uploads from a channel, playlist videos, or search results. */
type SourceConfig = ChannelRef | { searchQuery: string } | { playlistId: string };

type SyncConfig = {
  maxPerChannel?: number;
  hit: SourceConfig;
  script: SourceConfig;
};

interface PlaylistVideo {
  videoId: string;
  title: string;
  publishedAt: string;
}

function getWriteOutPath(): string | null {
  const i = process.argv.indexOf("--write");
  if (i === -1) return null;
  const next = process.argv[i + 1];
  if (next && !next.startsWith("-")) return path.resolve(process.cwd(), next);
  return path.join(process.cwd(), "src", "generated", "tracksFromYoutube.ts");
}

async function ytGet<T>(pathAndQuery: string, key: string): Promise<T> {
  const url = `${API}${pathAndQuery}${pathAndQuery.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const json = (await res.json()) as T & { error?: { message: string } };
  if (!res.ok) {
    const msg = json?.error?.message ?? res.statusText;
    throw new Error(`YouTube API ${res.status}: ${msg}`);
  }
  return json;
}

async function resolveChannelId(key: string, ref: ChannelRef): Promise<string> {
  if (ref.channelId?.startsWith("UC") && ref.channelId.length >= 20) {
    return ref.channelId;
  }
  const h = ref.handle?.replace(/^@/, "").trim();
  if (h) {
    try {
      const ch = await ytGet<{ items?: { id: string }[] }>(
        `/channels?part=id&forHandle=${encodeURIComponent(h)}`,
        key,
      );
      const id = ch.items?.[0]?.id;
      if (id) return id;
    } catch {
      // fall through to search
    }
    const search = await ytGet<{ items?: { snippet: { channelId: string } }[] }>(
      `/search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent("@" + h)}`,
      key,
    );
    const idSearch = search.items?.[0]?.snippet?.channelId;
    if (idSearch) return idSearch;
    throw new Error(`Could not resolve channel handle: ${h}`);
  }
  throw new Error("Channel source needs channelId or handle in youtube-sync.config.json");
}

async function getUploadsPlaylistId(key: string, channelId: string): Promise<string> {
  const data = await ytGet<{
    items?: { contentDetails: { relatedPlaylists: { uploads: string } } }[];
  }>(`/channels?part=contentDetails&id=${encodeURIComponent(channelId)}`, key);
  const up = data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!up) throw new Error(`No uploads playlist for channel ${channelId}`);
  return up;
}

async function listPlaylistVideos(
  key: string,
  playlistId: string,
  maxTotal: number,
): Promise<PlaylistVideo[]> {
  const out: PlaylistVideo[] = [];
  let pageToken: string | undefined;
  do {
    const tok = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const data = await ytGet<{
      nextPageToken?: string;
      items?: { snippet: { resourceId: { videoId: string }; title: string; publishedAt: string } }[];
    }>(
      `/playlistItems?part=snippet&playlistId=${encodeURIComponent(playlistId)}&maxResults=50${tok}`,
      key,
    );
    for (const it of data.items ?? []) {
      const vid = it.snippet.resourceId?.videoId;
      if (!vid) continue;
      out.push({
        videoId: vid,
        title: it.snippet.title,
        publishedAt: it.snippet.publishedAt,
      });
      if (out.length >= maxTotal) return out;
    }
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < maxTotal);
  return out;
}

async function listSearchVideos(key: string, query: string, maxTotal: number): Promise<PlaylistVideo[]> {
  const out: PlaylistVideo[] = [];
  let pageToken: string | undefined;
  const q = query.trim();
  if (!q) throw new Error("searchQuery must be non-empty");
  do {
    const tok = pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
    const data = await ytGet<{
      nextPageToken?: string;
      items?: {
        id: { videoId?: string };
        snippet: { title: string; publishedAt: string };
      }[];
    }>(
      `/search?part=snippet&type=video&maxResults=50&q=${encodeURIComponent(q)}${tok}`,
      key,
    );
    for (const it of data.items ?? []) {
      const vid = it.id?.videoId;
      if (!vid) continue;
      out.push({
        videoId: vid,
        title: it.snippet.title,
        publishedAt: it.snippet.publishedAt,
      });
      if (out.length >= maxTotal) return out;
    }
    pageToken = data.nextPageToken;
  } while (pageToken && out.length < maxTotal);
  return out;
}

function isSearchSource(s: SourceConfig): s is { searchQuery: string } {
  return typeof (s as { searchQuery?: string }).searchQuery === "string";
}

function isPlaylistSource(s: SourceConfig): s is { playlistId: string } {
  const p = (s as { playlistId?: string }).playlistId;
  return typeof p === "string" && p.length > 0;
}

function isChannelRef(s: SourceConfig): s is ChannelRef {
  if (isSearchSource(s) || isPlaylistSource(s)) return false;
  const c = s as ChannelRef;
  return !!(c.channelId?.trim() || c.handle?.trim());
}

async function videosFromSource(key: string, source: SourceConfig, maxTotal: number): Promise<PlaylistVideo[]> {
  if (isSearchSource(source)) {
    return listSearchVideos(key, source.searchQuery, maxTotal);
  }
  if (isPlaylistSource(source)) {
    return listPlaylistVideos(key, source.playlistId, maxTotal);
  }
  if (!isChannelRef(source)) {
    throw new Error("Each hit/script source needs searchQuery, playlistId, or channelId/handle");
  }
  const cid = await resolveChannelId(key, source);
  const pl = await getUploadsPlaylistId(key, cid);
  return listPlaylistVideos(key, pl, maxTotal);
}

function stableId(kind: TrackKind, videoId: string): string {
  return `yt-${kind}-${videoId}`;
}

/** YouTube ISO-8601 duration, e.g. `PT4M13S`, `PT1H2M3S`. */
function parseYoutubeIso8601Duration(iso: string): number {
  if (!iso.startsWith("PT")) return 0;
  let h = 0;
  let m = 0;
  let s = 0;
  const hMatch = /(\d+)H/.exec(iso);
  const mMatch = /(\d+)M/.exec(iso);
  const sMatch = /(\d+)S/.exec(iso);
  if (hMatch) h = Number.parseInt(hMatch[1]!, 10);
  if (mMatch) m = Number.parseInt(mMatch[1]!, 10);
  if (sMatch) s = Number.parseInt(sMatch[1]!, 10);
  return h * 3600 + m * 60 + s;
}

const CLIP_QUIZ_SEC = 20;
/** Keep in sync with `SHORT_TRACK_*` in game.ts. */
const SHORT_TRACK_MAX_DURATION_SEC = 30;
const SHORT_TRACK_CLIP_START_SEC = 3;
/** Keep in sync with `HIT_CLIP_START_*` in game.ts. */
const HIT_CLIP_LO = 60;
const HIT_CLIP_HI = 120;
/** Keep in sync with `SCRIPT_CLIP_START_*_SEC` in tracks.ts. */
const SCRIPT_CLIP_LO = 10;
const SCRIPT_CLIP_HI = 30;

/** Default `clipStartSec` in generated file; in-game uses the same rules. */
function suggestedClipStartSec(kind: TrackKind, durationSec: number | undefined): number {
  if (durationSec == null || !Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const maxStart = Math.max(0, Math.floor(durationSec - CLIP_QUIZ_SEC));
  if (maxStart <= 0) return 0;
  if (durationSec <= SHORT_TRACK_MAX_DURATION_SEC) {
    return Math.min(SHORT_TRACK_CLIP_START_SEC, maxStart);
  }
  const lo = kind === "hit" ? HIT_CLIP_LO : SCRIPT_CLIP_LO;
  const hi = kind === "hit" ? HIT_CLIP_HI : SCRIPT_CLIP_HI;
  const loC = Math.min(lo, maxStart);
  const hiC = Math.min(hi, maxStart);
  return Math.floor((loC + hiC) / 2);
}

async function fetchVideoDurationsById(key: string, videoIds: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(videoIds.filter((id) => id.length > 0))];
  const map = new Map<string, number>();
  const chunkSize = 50;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const idParam = chunk.map((id) => encodeURIComponent(id)).join(",");
    const data = await ytGet<{
      items?: { id: string; contentDetails?: { duration?: string } }[];
    }>(`/videos?part=contentDetails&id=${idParam}&maxResults=50`, key);
    for (const it of data.items ?? []) {
      const raw = it.contentDetails?.duration;
      if (!raw) continue;
      map.set(it.id, parseYoutubeIso8601Duration(raw));
    }
  }
  return map;
}

function tsString(s: string): string {
  return JSON.stringify(s);
}

function videosToTracks(
  kind: TrackKind,
  videos: PlaylistVideo[],
  durationByVideoId: Map<string, number>,
): Track[] {
  return videos.map((v): Track => {
    const durationSec = durationByVideoId.get(v.videoId);
    return {
      id: stableId(kind, v.videoId),
      kind,
      youtubeUrl: `https://www.youtube.com/watch?v=${v.videoId}`,
      clipStartSec: suggestedClipStartSec(kind, durationSec),
      youtubeDurationSec: durationSec,
      title: v.title,
    };
  });
}

function printTracksAsTs(tracks: Track[]): void {
  const lines = tracks.map((t) => {
    const parts = [
      "  {",
      `    id: ${tsString(t.id)},`,
      `    kind: ${tsString(t.kind)},`,
      `    youtubeUrl: ${tsString(t.youtubeUrl)},`,
      `    clipStartSec: ${t.clipStartSec},`,
    ];
    if (t.youtubeDurationSec != null) {
      parts.push(`    youtubeDurationSec: ${t.youtubeDurationSec},`);
    }
    if (t.title) parts.push(`    title: ${tsString(t.title)},`);
    if (t.artist) parts.push(`    artist: ${tsString(t.artist)},`);
    if (t.country) parts.push(`    country: ${tsString(t.country)},`);
    if (t.year != null) parts.push(`    year: ${t.year},`);
    if (t.story) parts.push(`    story: ${tsString(t.story)},`);
    if (t.revealNote) parts.push(`    revealNote: ${tsString(t.revealNote)},`);
    parts.push("  },");
    return parts.join("\n");
  });

  console.log(`// ${tracks.length} track(s) from YouTube — set artist, story/revealNote as needed.\n`);
  console.log(lines.join("\n\n"));
}

async function main(): Promise<void> {
  const key = process.env.YOUTUBE_API_KEY?.trim();
  if (!key) {
    console.error("Missing YOUTUBE_API_KEY. Export it or load from .env before running.");
    process.exit(1);
  }

  const configPath =
    (() => {
      const i = process.argv.indexOf("--config");
      if (i === -1) return path.join(process.cwd(), "youtube-sync.config.json");
      const next = process.argv[i + 1];
      return next && !next.startsWith("-")
        ? path.resolve(process.cwd(), next)
        : path.join(process.cwd(), "youtube-sync.config.json");
    })();
  if (!fs.existsSync(configPath)) {
    console.error(`Config not found: ${configPath}`);
    console.error("Copy youtube-sync.config.example.json and set hit/script (channel, searchQuery, or playlistId).");
    process.exit(1);
  }

  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8")) as SyncConfig;
  const max = Math.min(Math.max(cfg.maxPerChannel ?? 50, 1), 200);

  const hitVideos = await videosFromSource(key, cfg.hit, max);
  const scriptVideos = await videosFromSource(key, cfg.script, max);

  const allVideoIds = [...hitVideos, ...scriptVideos].map((v) => v.videoId);
  const durationByVideoId = await fetchVideoDurationsById(key, allVideoIds);

  const hitTracks = videosToTracks("hit", hitVideos, durationByVideoId);
  const scriptTracks = videosToTracks("script", scriptVideos, durationByVideoId);
  const all = [...hitTracks, ...scriptTracks];

  const outPath = getWriteOutPath();
  if (outPath) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const body = `import type { Track } from "../types/track.js";

/** Auto-generated by npm run youtube:pull — edit id, artist, story/revealNote. youtubeDurationSec is whole seconds (YouTube ISO duration), not ms; merged into TRACKS by id / video id in tracks.ts. */
export const TRACKS_FROM_YOUTUBE: Track[] = [
${all
  .map((t) => {
    const parts = ["  {"];
    parts.push(`    id: ${tsString(t.id)},`);
    parts.push(`    kind: ${tsString(t.kind)},`);
    parts.push(`    youtubeUrl: ${tsString(t.youtubeUrl)},`);
    parts.push(`    clipStartSec: ${t.clipStartSec},`);
    if (t.youtubeDurationSec != null) {
      parts.push(`    youtubeDurationSec: ${t.youtubeDurationSec},`);
    }
    if (t.title) parts.push(`    title: ${tsString(t.title)},`);
    parts.push("  },");
    return parts.join("\n");
  })
  .join("\n")}
];
`;
    fs.writeFileSync(outPath, body, "utf8");
    console.error(`Wrote ${all.length} entries to ${outPath}`);
  } else {
    printTracksAsTs(all);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
