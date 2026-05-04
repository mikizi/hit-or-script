/**
 * Loads https://www.youtube.com/iframe_api once so we can use YT.Player and onStateChange.
 */

declare global {
  namespace YT {
    interface PlayerEvent {
      target: Player;
      data: number;
    }
    interface Player {
      destroy(): void;
      pauseVideo(): void;
      playVideo(): void;
      unMute(): void;
      setVolume(volume: number): void;
      getDuration(): number;
      seekTo(seconds: number, allowSeekAhead: boolean): void;
    }
    interface PlayerConstructor {
      new (elementId: string | HTMLElement, options: Record<string, unknown>): Player;
    }
    interface PlayerStatic {
      Player: PlayerConstructor;
      PlayerState: {
        ENDED: number;
        PLAYING: number;
        PAUSED: number;
        BUFFERING: number;
        CUED: number;
        UNSTARTED: number;
      };
    }
  }
  interface Window {
    YT?: YT.PlayerStatic;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let iframeApiPromise: Promise<void> | null = null;

/** Resolves when `window.YT.Player` is available. */
export function ensureYoutubeIframeApi(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("No window"));
  }
  if (window.YT && typeof window.YT.Player === "function") {
    return Promise.resolve();
  }
  if (iframeApiPromise) {
    return iframeApiPromise;
  }
  iframeApiPromise = new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    tag.async = true;
    tag.onerror = () => {
      iframeApiPromise = null;
      reject(new Error("Could not load YouTube iframe API"));
    };
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      try {
        if (typeof prev === "function") {
          prev();
        }
      } catch {
        /* ignore */
      }
      resolve();
    };
    document.head.appendChild(tag);
  });
  return iframeApiPromise;
}
