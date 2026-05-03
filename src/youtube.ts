/**
 * Parses a watch / embed / shorts URL and returns the video id, or empty string.
 */
export function extractYoutubeVideoId(url: string): string {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0];
      return id ?? "";
    }

    const v = u.searchParams.get("v");
    if (v) {
      return v;
    }

    const embed = u.pathname.match(/\/embed\/([^/?]+)/);
    if (embed?.[1]) {
      return embed[1];
    }

    const shorts = u.pathname.match(/\/shorts\/([^/?]+)/);
    if (shorts?.[1]) {
      return shorts[1];
    }

    return "";
  } catch {
    return "";
  }
}
