# Hit or Script (`hit-or-script`)

A small browser game: listen to a short clip, then guess **Hit** (real Eurovision-style performance) or **Script** (AI / fan showcase). Built with Vite + TypeScript and a static deploy to **GitHub Pages**.

## Run locally

```bash
npm install
npm run dev
```

Then open the URL Vite prints (usually `http://localhost:5173`).

## Build

```bash
npm run build
```

Output is in `dist/`. The app uses `base: "./"` so it works as a project site on GitHub Pages.

## Deploy (GitHub Pages)

This repo includes [`.github/workflows/pages.yml`](.github/workflows/pages.yml). After you push to `main` or `master`:

1. On GitHub: **Settings → Pages**
2. Under **Build and deployment**, set **Source** to **GitHub Actions**

The workflow runs `npm ci` and `npm run build`, then publishes `dist/`.

## Optional: refresh tracks from YouTube

For maintainers only (needs a YouTube Data API key):

1. Copy `.env.example` to `.env` and add your key.
2. `npm run youtube:pull`

See `youtube-sync.config.example.json` for sync options.

## License

[MIT](LICENSE)
