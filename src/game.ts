import {
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
  const roundTracks = pool.slice(0, Math.min(ROUNDS_PER_GAME, pool.length));

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
  const yt = req<HTMLIFrameElement>("yt");
  const btnPlay = req<HTMLButtonElement>("btnPlay");
  const pulseMini = req<HTMLElement>("pulseMini");
  const btnHit = req<HTMLButtonElement>("btnHit");
  const btnScript = req<HTMLButtonElement>("btnScript");
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

  function pickHitClipStartSec(): number {
    const span = HIT_CLIP_START_MAX - HIT_CLIP_START_MIN + 1;
    return HIT_CLIP_START_MIN + Math.floor(Math.random() * span);
  }

  function pickScriptClipStartSec(): number {
    const span = SCRIPT_CLIP_START_MAX_SEC - SCRIPT_CLIP_START_MIN_SEC + 1;
    return SCRIPT_CLIP_START_MIN_SEC + Math.floor(Math.random() * span);
  }

  function clipStartForCurrentRound(): number {
    return roundClipStartSec;
  }

  /** Main round: start at the quiz offset; no `end` so audio keeps going while you think (points decay over {@link SCORE_WINDOW_SEC}s). */
  function embedUrl(t: TrackPayload): string {
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
      "&rel=0&modestbranding=1"
    );
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
      const w = yt.contentWindow;
      if (!w || !yt.src || yt.src.indexOf("youtube.com") === -1) return;
      w.postMessage(
        JSON.stringify({ event: "command", func: "pauseVideo", args: [] }),
        "*",
      );
    } catch {
      /* ignore */
    }
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
    if (!audioStarted || answered) {
      stopScoreClock();
      return;
    }
    const elapsedSec = (Date.now() - roundStartMs) / 1000;
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

  function pokeYoutubeAudio(): void {
    try {
      const w = yt.contentWindow;
      if (!w) return;
      const cmd = (funcName: string, args: unknown[] = []) =>
        JSON.stringify({ event: "command", func: funcName, args });
      w.postMessage(cmd("unMute"), "*");
      w.postMessage(cmd("setVolume", [100]), "*");
    } catch {
      /* ignore */
    }
  }

  function beginPlayback(): void {
    if (answered || showingFinale || audioStarted) return;
    audioStarted = true;
    roundStartMs = Date.now();
    const t = currentTrack();
    roundClipStartSec =
      t.kind === "hit" ? pickHitClipStartSec() : pickScriptClipStartSec();
    yt.onload = () => {
      if (!yt.src || yt.src.indexOf("youtube.com") === -1) return;
      [80, 400, 1000, 2200].forEach((ms) => {
        setTimeout(pokeYoutubeAudio, ms);
      });
    };
    yt.src = embedUrl(t);
    btnPlay.disabled = true;
    pulseMini.classList.remove("is-idle");
    btnHit.disabled = false;
    btnScript.disabled = false;
    startScoreClock();
  }

  function hideReveal(): void {
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

  function resetRoundUi(): void {
    audioStarted = false;
    answered = false;
    yt.onload = null;
    yt.src = "about:blank";
    btnPlay.disabled = false;
    pulseMini.classList.add("is-idle");
    btnHit.disabled = true;
    btnScript.disabled = true;
    stopScoreClock();
    hideReveal();
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
  }

  function pointsThisRound(correct: boolean): number {
    if (!correct) return 0;
    const elapsedSec = (Date.now() - roundStartMs) / 1000;
    const u = Math.min(Math.max(0, elapsedSec), SCORE_WINDOW_SEC);
    return Math.round(MAX_ROUND_SCORE * (1 - u / SCORE_WINDOW_SEC));
  }

  function onGuess(guess: "hit" | "script"): void {
    if (!audioStarted || answered) return;
    answered = true;
    stopScoreClock();
    btnHit.disabled = true;
    btnScript.disabled = true;
    pulseMini.classList.add("is-idle");
    const t = currentTrack();
    const correct = guess === t.kind;
    const roundPts = pointsThisRound(correct);
    if (correct) score += roundPts;
    scoreVal.textContent = String(score);
    openReveal(guess, correct, roundPts);
  }

  btnPlay.addEventListener("click", beginPlayback);

  btnHit.addEventListener("click", () => {
    if (!audioStarted || answered || showingFinale) return;
    onGuess("hit");
  });
  btnScript.addEventListener("click", () => {
    if (!audioStarted || answered || showingFinale) return;
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
    hideReveal();
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
      hideReveal();
      showingFinale = false;
    }
  });

  btnNext.addEventListener("click", () => {
    if (showingFinale) {
      hideReveal();
      showingFinale = false;
      return;
    }
    if (round >= roundTracks.length - 1) {
      showingFinale = true;
      const maxPossible = roundTracks.length * MAX_ROUND_SCORE;
      lastFinaleScore = score;
      lastFinaleMax = maxPossible;
      finaleSavedToBoard = false;
      revealVideoShell.style.display = "none";
      revealOutcome.innerHTML = "";
      revealYt.src = "about:blank";
      revealCard.className = "reveal-card reveal-card--correct";
      revealKindPill.style.display = "none";
      detailTitle.textContent = "Game over";
      const globalBoard = isGlobalLeaderboardConfigured();
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
    hideReveal();
    round += 1;
    resetRoundUi();
    renderRoundLabel();
  });

  buildFinaleFlagPicker();

  resetRoundUi();
  renderRoundLabel();
  void renderScoreboardList();
}
