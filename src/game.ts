import {
  CLIP_DURATION_SEC,
  SCRIPT_CLIP_START_MAX_SEC,
  SCRIPT_CLIP_START_MIN_SEC,
  TRACKS as TRACK_LIBRARY,
} from "./tracks";
import { resolveTrackFlagEmoji, SCOREBOARD_PICKER_FLAG_EMOJIS } from "./flags";
import {
  fetchGlobalLeaderboard,
  insertGlobalLeaderboardEntry,
  isGlobalLeaderboardConfigured,
} from "./leaderboardRemote";
import {
  addScoreboardEntry,
  ladderBadgeForPlace,
  loadScoreboard,
  runQualifiesAgainstEntries,
  runQualifiesForScoreboard,
  SCOREBOARD_MAX_ENTRIES,
  type ScoreboardEntry,
} from "./scoreboard";
import type { Track, TrackPayload } from "./types/track";
import { extractYoutubeVideoId } from "./youtube";
import { ensureYoutubeIframeApi } from "./youtubeIframeApi";

function toPayload(tracks: Track[]): TrackPayload[] {
  return tracks.map((t) => {
    const videoId = extractYoutubeVideoId(t.youtubeUrl);
    if (!videoId) {
      throw new Error(`Missing YouTube video id for track "${t.id}"`);
    }
    return {
      kind: t.kind,
      videoId,
      clipStartSec: t.clipStartSec,
      youtubeUrl: t.youtubeUrl,
      youtubeDurationSec: t.youtubeDurationSec,
      title: t.title,
      artist: t.artist,
      country: t.country,
      year: t.year,
      story: t.story,
      revealNote: t.revealNote,
    };
  });
}

/** Test: set back to `10` for a long run. */
const ROUNDS_PER_GAME = 5;
/** Countdown length after Play; max round score still {@link MAX_ROUND_SCORE} (~2 points lost per second). */
const SCORE_WINDOW_SEC = 50;
const MAX_ROUND_SCORE = 100;

/** Points still available this round (same scale as the ring). */
function playStagePointsLabel(rawPoints: number): string {
  const p = Math.max(0, Math.min(MAX_ROUND_SCORE, Math.round(rawPoints)));
  return String(p) + " points";
}
const HIT_CLIP_START_MIN = 60;
const HIT_CLIP_START_MAX = 120;

/** When total length is known and ≤ this, start at `SHORT_TRACK_CLIP_START_SEC` (clamped) instead of the 10–30s / 60–120s bands. */
const SHORT_TRACK_MAX_DURATION_SEC = 30;
const SHORT_TRACK_CLIP_START_SEC = 3;

function shuffleInPlace(a: TrackPayload[]): void {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]!;
    a[i] = a[j]!;
    a[j] = t;
  }
}

function req<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as unknown as T;
}

/** Boot Hit or Script UI (call once after DOM is ready). */
export function bootGame(): void {
  const ALL_TRACKS = toPayload(TRACK_LIBRARY);
  const pool = ALL_TRACKS.slice();
  shuffleInPlace(pool);
  const nRounds = Math.min(ROUNDS_PER_GAME, pool.length);
  const roundTracks = pool.slice(0, nRounds);
  /** Extra shuffled tracks for Skip swaps (ads, etc.). */
  const sparePool: TrackPayload[] = pool.slice(nRounds);

  /** One Skip per page load (all rounds). */
  let sessionSkipUsed = false;
  let skipSwapInProgress = false;

  let roundClipStartSec = 0;
  let round = 0;
  let score = 0;
  let roundStartMs = 0;
  let audioStarted = false;
  let answered = false;
  let showingFinale = false;
  let pointsDialRaf = 0;
  let lastFinaleScore = 0;
  let lastFinaleMax = 0;
  let finaleSavedToBoard = false;
  const ytHost = req<HTMLElement>("yt");
  let mainYtPlayer: YT.Player | null = null;
  /** True after first PLAYING (or fallback) so scoring matches real playback start. */
  let scoringYoutubeHasPlayed = false;
  /** Wall-clock ms spent paused / buffering while scoring is active (not during preroll before first play). */
  let scoringPauseAccumMs = 0;
  /** When non-PLAYING began after scoring started; null while playing. */
  let scoringPauseSinceMs: number | null = null;
  let playbackFallbackTimer: number | null = null;

  const PLAYBACK_FALLBACK_MS = 18000;

  const btnPlay = req<HTMLButtonElement>("btnPlay");
  const pulseMini = req<HTMLElement>("pulseMini");
  const btnHit = req<HTMLButtonElement>("btnHit");
  const btnScript = req<HTMLButtonElement>("btnScript");
  const choiceStack = req<HTMLElement>("choiceStack");
  const roundNum = req<HTMLElement>("roundNum");
  const roundTotal = req<HTMLElement>("roundTotal");
  const scoreVal = req<HTMLElement>("scoreVal");
  const reveal = req<HTMLElement>("reveal");
  const revealCard = req<HTMLElement>("revealCard");
  const revealCardBody = req<HTMLElement>("revealCardBody");
  const revealYt = req<HTMLIFrameElement>("revealYt");
  const revealVideoShell = req<HTMLElement>("revealVideoShell");
  const revealMediaBlock = req<HTMLElement>("revealMediaBlock");
  const revealOutcome = req<HTMLElement>("revealOutcome");
  const playStage = req<HTMLElement>("playStage");
  const playStageTimer = req<HTMLElement>("playStageTimer");
  const playStageScoreArc = req<SVGCircleElement>("playStageScoreArc");
  const btnSkipClip = req<HTMLButtonElement>("btnSkipClip");
  const detailFlag = req<HTMLElement>("detailFlag");
  const detailTitle = req<HTMLElement>("detailTitle");
  const detailMeta = req<HTMLElement>("detailMeta");
  const detailArtist = req<HTMLElement>("detailArtist");
  const detailStory = req<HTMLElement>("detailStory");
  const detailLink = req<HTMLElement>("detailLink");
  const revealKindPill = req<HTMLElement>("revealKindPill");
  const btnNext = req<HTMLButtonElement>("btnNext");
  const btnNextLabel = req<HTMLSpanElement>("btnNextLabel");
  const revealCardActions = req<HTMLElement>("revealCardActions");
  const revealCardMotion = req<HTMLElement>("revealCardMotion");
  const btnAddScoreboard = req<HTMLButtonElement>("btnAddScoreboard");
  const finaleEscBlock = req<HTMLElement>("finaleEscBlock");
  const finaleEscMain = req<HTMLElement>("finaleEscMain");
  const finaleSaveBlock = req<HTMLElement>("finaleSaveBlock");
  const finaleScoreboardName = req<HTMLInputElement>("finaleScoreboardName");
  const finaleFlagGrid = req<HTMLElement>("finaleFlagGrid");
  const finaleSaveError = req<HTMLParagraphElement>("finaleSaveError");
  let selectedFinaleFlag = "";
  const btnScoreboard = req<HTMLButtonElement>("btnScoreboard");
  const btnScoreboardClose = req<HTMLButtonElement>("btnScoreboardClose");
  const scoreboardOverlay = req<HTMLElement>("scoreboardOverlay");
  const scoreboardList = req<HTMLOListElement>("scoreboardList");
  const scoreboardEmpty = req<HTMLElement>("scoreboardEmpty");
  const scoreboardLoading = req<HTMLElement>("scoreboardLoading");
  const scoreboardTitle = req<HTMLElement>("scoreboardTitle");

  const localScoreboardEmptyText =
    scoreboardEmpty.textContent?.replace(/\s+/g, " ").trim() ?? "";

  const SCOREBOARD_MSG_GLOBAL_EMPTY =
    "No scores on the global board yet. Finish a game and add yours — it syncs for everyone.";
  const SCOREBOARD_MSG_GLOBAL_ERR =
    "Could not load the global leaderboard. Check your connection and try opening Scoreboard again.";

  roundTotal.textContent = String(roundTracks.length);

  function clearFinaleSaveError(): void {
    finaleSaveError.hidden = true;
    finaleSaveError.textContent = "";
    finaleFlagGrid.classList.remove("finale-esc__flags-grid--invalid");
  }

  function showFinaleSaveError(message: string): void {
    finaleSaveError.textContent = message;
    finaleSaveError.hidden = false;
  }

  function resetFinaleFlagPicker(): void {
    selectedFinaleFlag = "";
    finaleFlagGrid.querySelectorAll(".finale-esc__flag-chip").forEach((el) => {
      el.setAttribute("aria-pressed", "false");
    });
  }

  function buildFinaleFlagPicker(): void {
    finaleFlagGrid.innerHTML = "";
    for (const emoji of SCOREBOARD_PICKER_FLAG_EMOJIS) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "finale-esc__flag-chip";
      chip.textContent = emoji;
      chip.setAttribute("aria-pressed", "false");
      chip.setAttribute("aria-label", "Flag " + emoji);
      chip.addEventListener("click", () => {
        finaleFlagGrid.querySelectorAll(".finale-esc__flag-chip").forEach((el) => {
          el.setAttribute("aria-pressed", "false");
        });
        chip.setAttribute("aria-pressed", "true");
        selectedFinaleFlag = emoji;
        clearFinaleSaveError();
      });
      finaleFlagGrid.appendChild(chip);
    }
  }

  function renderScoreboardRows(entries: readonly ScoreboardEntry[]): void {
    scoreboardList.innerHTML = "";
    entries.forEach((e, i) => {
      const badge = ladderBadgeForPlace(i);
      const li = document.createElement("li");
      li.className = "sb-row";
      li.innerHTML =
        '<span class="sb-row__badge" aria-hidden="true">' +
        String(badge) +
        "</span>" +
        '<div class="sb-row__main">' +
        '<span class="sb-row__name">' +
        '<span class="sb-row__flag" aria-hidden="true"></span>' +
        '<span class="sb-row__name-text"></span>' +
        "</span>" +
        '<span class="sb-row__pts"><strong></strong> / ' +
        String(e.maxPossible) +
        "</span></div>";
      const flagEl = li.querySelector(".sb-row__flag");
      const nameText = li.querySelector(".sb-row__name-text");
      if (e.flag && flagEl) {
        flagEl.textContent = e.flag;
        (flagEl as HTMLElement).style.display = "";
      } else if (flagEl) {
        (flagEl as HTMLElement).style.display = "none";
      }
      if (nameText) nameText.textContent = e.label;
      const strong = li.querySelector("strong");
      if (strong) strong.textContent = String(e.score);
      scoreboardList.appendChild(li);
    });
  }

  async function renderScoreboardList(): Promise<void> {
    const global = isGlobalLeaderboardConfigured();
    scoreboardTitle.textContent = global ? "World scoreboard" : "Scoreboard";
    scoreboardList.setAttribute(
      "aria-label",
      global ? "Global leaderboard" : "Saved scores",
    );

    if (global) {
      scoreboardLoading.hidden = false;
      scoreboardEmpty.classList.add("is-hidden");
    } else {
      scoreboardLoading.hidden = true;
    }

    let entries: ScoreboardEntry[] = [];
    let loadError = false;
    try {
      if (global) {
        entries = await fetchGlobalLeaderboard();
      } else {
        entries = loadScoreboard();
      }
    } catch {
      entries = [];
      loadError = global;
    } finally {
      scoreboardLoading.hidden = true;
    }

    if (entries.length === 0) {
      scoreboardEmpty.classList.remove("is-hidden");
      scoreboardEmpty.textContent = loadError
        ? SCOREBOARD_MSG_GLOBAL_ERR
        : global
          ? SCOREBOARD_MSG_GLOBAL_EMPTY
          : localScoreboardEmptyText;
      return;
    }

    scoreboardEmpty.classList.add("is-hidden");
    renderScoreboardRows(entries);
  }

  function openScoreboard(): void {
    scoreboardOverlay.classList.add("is-open");
    scoreboardOverlay.setAttribute("aria-hidden", "false");
    btnScoreboard.setAttribute("aria-expanded", "true");
    void renderScoreboardList();
    btnScoreboardClose.focus();
  }

  function closeScoreboard(): void {
    scoreboardOverlay.classList.remove("is-open");
    scoreboardOverlay.setAttribute("aria-hidden", "true");
    btnScoreboard.setAttribute("aria-expanded", "false");
  }

  function currentTrack(): TrackPayload {
    return roundTracks[round]!;
  }

  function replacementBlockedVideoIds(): Set<string> {
    const blocked = new Set<string>();
    roundTracks.forEach((t, i) => {
      if (i !== round) blocked.add(t.videoId);
    });
    blocked.add(roundTracks[round]!.videoId);
    return blocked;
  }

  /**
   * @param consumeSpare - When true, remove chosen track from `sparePool` if it came from there.
   */
  function pickReplacementTrack(consumeSpare: boolean): TrackPayload | null {
    const blocked = replacementBlockedVideoIds();
    const allow = (t: TrackPayload): boolean => !blocked.has(t.videoId);
    for (let s = 0; s < sparePool.length; s++) {
      const t = sparePool[s]!;
      if (!allow(t)) continue;
      if (consumeSpare) sparePool.splice(s, 1);
      return t;
    }
    const picks = ALL_TRACKS.filter(allow);
    if (picks.length === 0) return null;
    return picks[Math.floor(Math.random() * picks.length)]!;
  }

  function hasReplacementTrack(): boolean {
    return pickReplacementTrack(false) !== null;
  }

  function takeReplacementTrack(): TrackPayload | null {
    return pickReplacementTrack(true);
  }

  /**
   * Random clip start in the usual band, clamped so `start + CLIP_DURATION_SEC` fits inside the video when duration is known.
   * Very short clips (≤30s) start at 3s (or lower if the video cannot fit a full quiz window after that).
   */
  function pickClipStartSecForTrack(t: TrackPayload): number {
    const lo = t.kind === "hit" ? HIT_CLIP_START_MIN : SCRIPT_CLIP_START_MIN_SEC;
    const hi = t.kind === "hit" ? HIT_CLIP_START_MAX : SCRIPT_CLIP_START_MAX_SEC;
    const dur = t.youtubeDurationSec;
    if (dur == null || !Number.isFinite(dur) || dur <= 0) {
      return lo + Math.floor(Math.random() * (hi - lo + 1));
    }
    const maxStart = Math.max(0, Math.floor(dur - CLIP_DURATION_SEC));
    if (maxStart <= 0) return 0;
    if (dur <= SHORT_TRACK_MAX_DURATION_SEC) {
      return Math.min(SHORT_TRACK_CLIP_START_SEC, maxStart);
    }
    const loC = Math.min(lo, maxStart);
    const hiC = Math.min(hi, maxStart);
    return loC + Math.floor(Math.random() * (hiC - loC + 1));
  }

  function clipStartForCurrentRound(): number {
    return roundClipStartSec;
  }

  /** Replay after a guess: same start as the round, no `end` so YouTube does not cut off at 20s. */
  function embedUrlReveal(t: TrackPayload): string {
    const start = clipStartForCurrentRound();
    return (
      "https://www.youtube.com/embed/" +
      t.videoId +
      "?start=" +
      start +
      "&autoplay=1" +
      "&mute=0" +
      "&playsinline=1" +
      "&controls=0" +
      "&enablejsapi=1" +
      "&rel=0&modestbranding=1&iv_load_policy=3"
    );
  }

  function pauseMainClip(): void {
    try {
      mainYtPlayer?.pauseVideo();
    } catch {
      /* ignore */
    }
  }

  function clearPlaybackFallbackTimer(): void {
    if (playbackFallbackTimer !== null) {
      window.clearTimeout(playbackFallbackTimer);
      playbackFallbackTimer = null;
    }
  }

  function destroyMainPlayer(): void {
    clearPlaybackFallbackTimer();
    try {
      mainYtPlayer?.destroy();
    } catch {
      /* ignore */
    }
    mainYtPlayer = null;
  }

  function mountYoutubePlayer(): void {
    destroyMainPlayer();
    const t = currentTrack();
    const YT = window.YT!;
    const PS = YT.PlayerState;
    mainYtPlayer = new YT.Player(ytHost, {
      videoId: t.videoId,
      height: "315",
      width: "560",
      playerVars: {
        autoplay: 1,
        start: roundClipStartSec,
        controls: 0,
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        enablejsapi: 1,
        origin: window.location.origin,
        iv_load_policy: 3,
        fs: 0,
        disablekb: 1,
      },
      events: {
        onReady: (e: YT.PlayerEvent) => {
          e.target.unMute();
          e.target.setVolume(100);
          e.target.playVideo();
        },
        onStateChange: (e: YT.PlayerEvent) => {
          const st = e.data;
          if (st === PS.PLAYING) {
            if (!scoringYoutubeHasPlayed) {
              beginScoringFromPlayback();
            } else if (scoringPauseSinceMs !== null) {
              scoringPauseAccumMs += Date.now() - scoringPauseSinceMs;
              scoringPauseSinceMs = null;
            }
          } else if (
            scoringYoutubeHasPlayed &&
            (st === PS.PAUSED || st === PS.BUFFERING || st === PS.CUED)
          ) {
            if (scoringPauseSinceMs === null) {
              scoringPauseSinceMs = Date.now();
            }
          }
        },
      },
    });

    playbackFallbackTimer = window.setTimeout(() => {
      playbackFallbackTimer = null;
      if (!audioStarted || answered || scoringYoutubeHasPlayed) return;
      beginScoringFromPlayback();
    }, PLAYBACK_FALLBACK_MS);
  }

  /** Start the points ring and guessing once playback is confirmed (or fallback timeout). */
  function beginScoringFromPlayback(): void {
    if (scoringYoutubeHasPlayed) return;
    clearPlaybackFallbackTimer();
    scoringYoutubeHasPlayed = true;
    roundStartMs = Date.now();
    scoringPauseAccumMs = 0;
    scoringPauseSinceMs = null;
    playStage.classList.remove("is-loading");
    pulseMini.classList.remove("is-idle");
    startScoreClock();
    btnHit.disabled = false;
    btnScript.disabled = false;
    playStageTimer.textContent = playStagePointsLabel(MAX_ROUND_SCORE);
    if (!sessionSkipUsed) {
      btnSkipClip.disabled = !hasReplacementTrack();
    }
  }

  /** Effective seconds into the scoring window (pauses during buffer / pause after play began). */
  function scoreElapsedSec(): number {
    if (!scoringYoutubeHasPlayed) return 0;
    const now = Date.now();
    const activePauseMs = scoringPauseSinceMs !== null ? now - scoringPauseSinceMs : 0;
    return (now - roundStartMs - scoringPauseAccumMs - activePauseMs) / 1000;
  }

  function renderRevealOutcome(correct: boolean, roundPoints: number): void {
    const t = currentTrack();
    const clipWasAi = t.kind === "script";
    const badgeClass = correct ? "reveal-outcome__badge--ok" : "reveal-outcome__badge--bad";
    const badgeIcon = correct ? "check_circle" : "cancel";
    const badgeText = correct ? "You were right" : "You were wrong";
    const factValue = clipWasAi ? "AI-generated" : "Not AI (real)";
    const factHint = clipWasAi
      ? "Fan or AI-style showcase clip — not labelled as a fake official entry."
      : "Real Eurovision or catalogue recording for this round.";
    const ptsBadgeClass =
      "reveal-outcome__points-badge " +
      (correct ? "reveal-outcome__points-badge--gain" : "reveal-outcome__points-badge--none");
    const ptsLabel = correct ? String(roundPoints) + " PTS" : "0 PTS";
    revealOutcome.innerHTML =
      '<div class="reveal-outcome__head">' +
      '<p class="reveal-outcome__kicker">' +
      badgeText +
      "</p>" +
      '<div class="reveal-outcome__status-row">' +
      '<div class="reveal-outcome__badge ' +
      badgeClass +
      '"><span class="material-symbols-outlined filled" aria-hidden="true">' +
      badgeIcon +
      '</span><span class="reveal-outcome__badge-text">' +
      badgeText +
      "</span></div>" +
      '<div class="' +
      ptsBadgeClass +
      '"><span class="material-symbols-outlined reveal-outcome__pts-glyph filled" aria-hidden="true">military_tech</span>' +
      '<span class="reveal-outcome__pts-text">' +
      ptsLabel +
      "</span></div>" +
      "</div>" +
      "</div>" +
      '<div class="reveal-outcome__fact ' +
      (clipWasAi ? "reveal-outcome__fact--ai" : "reveal-outcome__fact--real") +
      '"><p class="reveal-outcome__fact-label">This clip was</p><p class="reveal-outcome__fact-value">' +
      factValue +
      '</p><p class="reveal-outcome__fact-hint">' +
      factHint +
      "</p></div>";
  }

  function stopScoreClock(): void {
    if (pointsDialRaf !== 0) {
      cancelAnimationFrame(pointsDialRaf);
      pointsDialRaf = 0;
    }
    playStage.classList.remove("is-scoring");
    playStageTimer.textContent = playStagePointsLabel(MAX_ROUND_SCORE);
    playStageScoreArc.style.strokeDashoffset = "0";
  }

  function tickScoreClock(): void {
    if (!audioStarted || answered || !scoringYoutubeHasPlayed) {
      stopScoreClock();
      return;
    }
    const elapsedSec = scoreElapsedSec();
    const u = Math.min(Math.max(0, elapsedSec), SCORE_WINDOW_SEC);
    const frac = 1 - u / SCORE_WINDOW_SEC;
    playStageTimer.textContent = playStagePointsLabel(MAX_ROUND_SCORE * frac);
    playStageScoreArc.style.strokeDashoffset = String(100 * (1 - frac));
    pointsDialRaf = requestAnimationFrame(tickScoreClock);
  }

  function startScoreClock(): void {
    if (pointsDialRaf !== 0) {
      cancelAnimationFrame(pointsDialRaf);
      pointsDialRaf = 0;
    }
    playStage.classList.add("is-scoring");
    playStageTimer.textContent = playStagePointsLabel(MAX_ROUND_SCORE);
    playStageScoreArc.style.strokeDashoffset = "0";
    pointsDialRaf = requestAnimationFrame(tickScoreClock);
  }

  async function beginPlayback(): Promise<void> {
    if (answered || showingFinale || audioStarted) return;
    audioStarted = true;
    scoringYoutubeHasPlayed = false;
    scoringPauseAccumMs = 0;
    scoringPauseSinceMs = null;
    const t = currentTrack();
    roundClipStartSec = pickClipStartSecForTrack(t);

    choiceStack.classList.add("choice-stack--after-play");

    btnPlay.disabled = true;
    pulseMini.classList.add("is-idle");
    btnHit.disabled = true;
    btnScript.disabled = true;
    playStage.classList.add("is-loading");
    playStageTimer.textContent = "Starting…";
    stopScoreClock();

    try {
      await ensureYoutubeIframeApi();
    } catch {
      audioStarted = false;
      choiceStack.classList.remove("choice-stack--after-play");
      btnPlay.disabled = false;
      pulseMini.classList.add("is-idle");
      playStage.classList.remove("is-loading");
      playStageTimer.textContent = playStagePointsLabel(MAX_ROUND_SCORE);
      return;
    }

    mountYoutubePlayer();
    if (sessionSkipUsed) {
      btnSkipClip.hidden = true;
    } else {
      btnSkipClip.hidden = false;
      btnSkipClip.disabled = !hasReplacementTrack();
    }
  }

  async function skipToNewClip(): Promise<void> {
    if (sessionSkipUsed || skipSwapInProgress || !audioStarted || answered || showingFinale) return;
    skipSwapInProgress = true;
    btnSkipClip.disabled = true;
    try {
      const next = takeReplacementTrack();
      if (!next) {
        btnSkipClip.disabled = !hasReplacementTrack();
        return;
      }
      roundTracks[round] = next;
      roundClipStartSec = pickClipStartSecForTrack(next);
      scoringYoutubeHasPlayed = false;
      scoringPauseAccumMs = 0;
      scoringPauseSinceMs = null;
      stopScoreClock();
      btnHit.disabled = true;
      btnScript.disabled = true;
      pulseMini.classList.add("is-idle");
      playStage.classList.add("is-loading");
      playStageTimer.textContent = "Loading…";
      try {
        await ensureYoutubeIframeApi();
      } catch {
        playStage.classList.remove("is-loading");
        return;
      }
      mountYoutubePlayer();
      sessionSkipUsed = true;
      btnSkipClip.hidden = true;
    } finally {
      skipSwapInProgress = false;
      if (!sessionSkipUsed && !btnSkipClip.hidden) {
        btnSkipClip.disabled = !hasReplacementTrack();
      }
    }
  }

  function prefersRevealMotion(): boolean {
    return !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  function waitMotionTransformEnd(el: HTMLElement, timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        el.removeEventListener("transitionend", onEnd);
        resolve();
      };
      const onEnd = (ev: TransitionEvent): void => {
        if (ev.target !== el || ev.propertyName !== "transform") return;
        finish();
      };
      el.addEventListener("transitionend", onEnd);
      window.setTimeout(finish, timeoutMs);
    });
  }

  function hideRevealNow(): void {
    reveal.classList.remove("open");
    reveal.setAttribute("aria-hidden", "true");
    revealCard.className = "reveal-card";
    revealVideoShell.style.display = "";
    revealYt.src = "about:blank";
    revealOutcome.innerHTML = "";
    revealMediaBlock.style.display = "";
    detailFlag.textContent = "";
    detailFlag.style.display = "none";
    revealKindPill.style.display = "";
    finaleEscMain.innerHTML = "";
    finaleEscBlock.hidden = true;
    finaleSaveBlock.hidden = false;
    finaleScoreboardName.value = "";
    finaleScoreboardName.disabled = false;
    btnAddScoreboard.disabled = false;
    btnAddScoreboard.textContent = "Add to scoreboard";
    finaleSavedToBoard = false;
    resetFinaleFlagPicker();
    clearFinaleSaveError();
    revealCardActions.hidden = false;
  }

  async function hideRevealAsync(opts?: { animate?: boolean }): Promise<void> {
    const useMotion =
      opts?.animate === true && prefersRevealMotion() && reveal.classList.contains("open");
    if (!useMotion) {
      hideRevealNow();
      return;
    }
    revealCard.classList.remove("reveal-card--flip-preset", "reveal-card--flip-show");
    revealCard.classList.add("reveal-card--flip-hide");
    await waitMotionTransformEnd(revealCardMotion, 720);
    hideRevealNow();
  }

  /** Flip the card away, swap inner content, then flip back (e.g. round result → finale). */
  async function flipRevealMidRound(update: () => void): Promise<void> {
    if (!prefersRevealMotion() || !reveal.classList.contains("open")) {
      update();
      return;
    }
    revealCard.classList.remove("reveal-card--flip-preset", "reveal-card--flip-show");
    revealCard.classList.add("reveal-card--flip-hide");
    await waitMotionTransformEnd(revealCardMotion, 720);
    update();
    revealCard.classList.remove("reveal-card--flip-hide");
    revealCard.classList.add("reveal-card--flip-preset");
    void revealCardMotion.offsetHeight;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        revealCard.classList.remove("reveal-card--flip-preset");
        revealCard.classList.add("reveal-card--flip-show");
        resolve();
      });
    });
    await waitMotionTransformEnd(revealCardMotion, 720);
  }

  function runRevealFlipIn(): void {
    if (!prefersRevealMotion()) return;
    revealCard.classList.remove("reveal-card--flip-hide", "reveal-card--flip-show");
    revealCard.classList.add("reveal-card--flip-preset");
    void revealCardMotion.offsetHeight;
    requestAnimationFrame(() => {
      revealCard.classList.remove("reveal-card--flip-preset");
      revealCard.classList.add("reveal-card--flip-show");
    });
  }

  function resetRoundUi(): void {
    audioStarted = false;
    answered = false;
    scoringYoutubeHasPlayed = false;
    scoringPauseAccumMs = 0;
    scoringPauseSinceMs = null;
    destroyMainPlayer();
    btnPlay.disabled = false;
    pulseMini.classList.add("is-idle");
    btnHit.disabled = true;
    btnScript.disabled = true;
    playStage.classList.remove("is-loading");
    btnSkipClip.hidden = true;
    btnSkipClip.disabled = false;
    stopScoreClock();
    hideRevealNow();
    choiceStack.classList.remove("choice-stack--after-play");
  }

  function renderRoundLabel(): void {
    roundNum.textContent = String(round + 1);
    scoreVal.textContent = String(score);
  }

  function openReveal(_guess: "hit" | "script", correct: boolean, roundPoints: number): void {
    const t = currentTrack();

    finaleEscBlock.hidden = true;
    finaleEscMain.innerHTML = "";
    revealKindPill.style.display = "";

    pauseMainClip();
    revealMediaBlock.style.display = "";
    revealVideoShell.style.display = "";
    revealYt.src = embedUrlReveal(t);

    revealCard.className = "reveal-card " + (correct ? "reveal-card--correct" : "reveal-card--wrong");

    let eyebrow = "";
    if (t.kind === "hit" && t.country) {
      eyebrow = "Winner: " + t.country;
    } else if (t.kind === "hit") {
      eyebrow = "Eurovision entry";
    } else {
      eyebrow = "Fan / AI showcase";
    }
    detailMeta.textContent =
      typeof t.year === "number" && !Number.isNaN(t.year) ? String(t.year) + " · " + eyebrow : eyebrow;

    revealKindPill.textContent = t.kind === "hit" ? "Real Eurovision" : "Fan / AI showcase";
    revealKindPill.className = "reveal-kind-pill reveal-kind-pill--" + t.kind;

    const flagEmoji = resolveTrackFlagEmoji(t.country, t.title);
    if (flagEmoji) {
      detailFlag.textContent = flagEmoji;
      detailFlag.style.display = "block";
    } else {
      detailFlag.textContent = "";
      detailFlag.style.display = "none";
    }

    const titleParts: string[] = [];
    if (t.title) titleParts.push(t.title);
    detailTitle.textContent = titleParts.length
      ? titleParts.join(" — ")
      : t.kind === "hit"
        ? "Official entry"
        : "Generated clip";

    detailArtist.textContent = t.artist || "";

    let storyText = "";
    if (t.kind === "hit" && t.story) storyText = t.story;
    else if (t.kind === "script" && t.revealNote) storyText = t.revealNote;
    if (storyText) {
      detailStory.textContent = storyText;
      detailStory.style.display = "block";
    } else {
      detailStory.textContent = "";
      detailStory.style.display = "none";
    }

    renderRevealOutcome(correct, roundPoints);

    detailLink.innerHTML =
      '<a href="' +
      t.youtubeUrl +
      '" target="_blank" rel="noopener noreferrer">Open on YouTube</a>';

    reveal.classList.add("open");
    reveal.setAttribute("aria-hidden", "false");
    revealCardBody.scrollTop = 0;

    const last = round >= roundTracks.length - 1;
    btnNextLabel.textContent = last ? "Final score" : "Next song";

    runRevealFlipIn();
  }

  function pointsThisRound(correct: boolean): number {
    if (!correct) return 0;
    const elapsedSec = Math.min(Math.max(0, scoreElapsedSec()), SCORE_WINDOW_SEC);
    return Math.round(MAX_ROUND_SCORE * (1 - elapsedSec / SCORE_WINDOW_SEC));
  }

  function onGuess(guess: "hit" | "script"): void {
    if (!audioStarted || !scoringYoutubeHasPlayed || answered) return;
    answered = true;
    stopScoreClock();
    btnHit.disabled = true;
    btnScript.disabled = true;
    btnSkipClip.hidden = true;
    pulseMini.classList.add("is-idle");
    const t = currentTrack();
    const correct = guess === t.kind;
    const roundPts = pointsThisRound(correct);
    if (correct) score += roundPts;
    scoreVal.textContent = String(score);
    openReveal(guess, correct, roundPts);
  }

  btnPlay.addEventListener("click", () => {
    void beginPlayback();
  });

  btnSkipClip.addEventListener("click", () => {
    void skipToNewClip();
  });

  btnHit.addEventListener("click", () => {
    if (!audioStarted || !scoringYoutubeHasPlayed || answered || showingFinale) return;
    onGuess("hit");
  });
  btnScript.addEventListener("click", () => {
    if (!audioStarted || !scoringYoutubeHasPlayed || answered || showingFinale) return;
    onGuess("script");
  });

  async function submitFinaleScoreboard(): Promise<void> {
    if (!showingFinale || finaleSavedToBoard) return;
    clearFinaleSaveError();
    if (!finaleScoreboardName.checkValidity()) {
      finaleScoreboardName.reportValidity();
      return;
    }
    const raw = finaleScoreboardName.value.trim();
    if (!raw) {
      showFinaleSaveError("Enter your name.");
      return;
    }
    if (!selectedFinaleFlag) {
      showFinaleSaveError("Pick a flag.");
      finaleFlagGrid.classList.add("finale-esc__flags-grid--invalid");
      return;
    }
    const global = isGlobalLeaderboardConfigured();
    btnAddScoreboard.disabled = true;
    finaleSavedToBoard = true;
    try {
      if (global) {
        const board = await fetchGlobalLeaderboard();
        if (!runQualifiesAgainstEntries(lastFinaleScore, board)) {
          finaleSavedToBoard = false;
          btnAddScoreboard.disabled = false;
          showFinaleSaveError(
            "The top " +
              String(SCOREBOARD_MAX_ENTRIES) +
              " scores changed — yours would not be saved now. Close and try another run.",
          );
          return;
        }
        await insertGlobalLeaderboardEntry({
          label: raw,
          score: lastFinaleScore,
          maxPossible: lastFinaleMax,
          flag: selectedFinaleFlag,
        });
      } else {
        if (!runQualifiesForScoreboard(lastFinaleScore)) {
          finaleSavedToBoard = false;
          btnAddScoreboard.disabled = false;
          return;
        }
        addScoreboardEntry(raw, lastFinaleScore, lastFinaleMax, selectedFinaleFlag);
      }
    } catch (err) {
      finaleSavedToBoard = false;
      btnAddScoreboard.disabled = false;
      showFinaleSaveError(err instanceof Error ? err.message : "Could not save.");
      return;
    }
    btnAddScoreboard.disabled = false;
    await hideRevealAsync({ animate: true });
    showingFinale = false;
    openScoreboard();
  }

  btnAddScoreboard.addEventListener("click", () => {
    void submitFinaleScoreboard();
  });

  finaleScoreboardName.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    void submitFinaleScoreboard();
  });

  btnScoreboard.addEventListener("click", () => {
    openScoreboard();
  });
  btnScoreboardClose.addEventListener("click", () => {
    closeScoreboard();
  });
  scoreboardOverlay.addEventListener("click", (ev) => {
    if (ev.target === scoreboardOverlay) closeScoreboard();
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (scoreboardOverlay.classList.contains("is-open")) {
      ev.preventDefault();
      closeScoreboard();
      return;
    }
    if (showingFinale && reveal.classList.contains("open")) {
      ev.preventDefault();
      void hideRevealAsync({ animate: true }).then(() => {
        showingFinale = false;
      });
    }
  });

  async function onBtnNextClick(): Promise<void> {
    if (showingFinale) {
      await hideRevealAsync({ animate: true });
      showingFinale = false;
      return;
    }
    if (round >= roundTracks.length - 1) {
      const globalBoard = isGlobalLeaderboardConfigured();
      const maxPossible = roundTracks.length * MAX_ROUND_SCORE;
      const n = roundTracks.length;
      const applyFinaleSaveUi = (canSave: boolean): void => {
        finaleSaveBlock.hidden = !canSave;
        revealCardActions.hidden = canSave;
        detailMeta.textContent = canSave
          ? String(n) +
            (globalBoard
              ? " songs complete. Enter your name, pick a flag, then add your run to the world scoreboard. Press Escape to leave without saving."
              : " songs complete. Enter your name, pick a flag, then add your run — the scoreboard opens after save. Press Escape to leave without saving.")
          : String(n) +
            " songs complete. Sorry — we only keep the top " +
            String(SCOREBOARD_MAX_ENTRIES) +
            (globalBoard
              ? " scores on the world board, and yours would not be saved. Tap Close to continue, or open Scoreboard in the header."
              : " scores, and yours would not be saved. Tap Close to continue, or open Scoreboard in the header to see saved runs.");
        if (canSave) {
          resetFinaleFlagPicker();
          clearFinaleSaveError();
        }
      };

      await flipRevealMidRound(() => {
        showingFinale = true;
        lastFinaleScore = score;
        lastFinaleMax = maxPossible;
        finaleSavedToBoard = false;
        revealVideoShell.style.display = "none";
        revealOutcome.innerHTML = "";
        revealYt.src = "about:blank";
        revealCard.className = "reveal-card reveal-card--correct";
        revealKindPill.style.display = "none";
        detailTitle.textContent = "Game over";
        detailFlag.textContent = "";
        detailFlag.style.display = "none";
        detailArtist.textContent = "";
        finaleEscBlock.hidden = false;
        finaleEscMain.innerHTML =
          '<p class="finale-esc__eyebrow">Total points</p>' +
          '<p class="finale-esc__score">' +
          String(score) +
          "</p>" +
          '<p class="finale-esc__max">out of ' +
          String(maxPossible) +
          " max</p>";
        finaleScoreboardName.value = "";
        finaleScoreboardName.disabled = false;
        detailStory.textContent = "";
        detailStory.style.display = "none";
        detailLink.innerHTML = "";
        btnAddScoreboard.disabled = false;
        btnAddScoreboard.textContent = globalBoard ? "Add to world scoreboard" : "Add to scoreboard";
        btnNextLabel.textContent = "Close";
        reveal.classList.add("open");
        reveal.setAttribute("aria-hidden", "false");
        revealCardBody.scrollTop = 0;
      });

      if (globalBoard) {
        finaleSaveBlock.hidden = true;
        revealCardActions.hidden = true;
        detailMeta.textContent = "Checking world scoreboard…";
        void (async () => {
          let entries: ScoreboardEntry[] = [];
          try {
            entries = await fetchGlobalLeaderboard();
          } catch {
            entries = [];
          }
          if (!showingFinale || !reveal.classList.contains("open")) return;
          applyFinaleSaveUi(runQualifiesAgainstEntries(score, entries));
        })();
      } else {
        applyFinaleSaveUi(runQualifiesForScoreboard(score));
      }

      return;
    }
    await hideRevealAsync({ animate: true });
    round += 1;
    resetRoundUi();
    renderRoundLabel();
  }

  btnNext.addEventListener("click", () => {
    void onBtnNextClick();
  });

  buildFinaleFlagPicker();

  resetRoundUi();
  renderRoundLabel();
  void renderScoreboardList();
}
