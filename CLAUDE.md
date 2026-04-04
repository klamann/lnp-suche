# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Full-text search web app for **Logbuch:Netzpolitik** (LNP) podcast transcripts. Two standalone Python scripts fetch WEBVTT transcripts from the RSS feed and build a static site with a Pagefind search index, deployed daily to GitHub Pages.

All content is in German.

## Commands

Both Python scripts use PEP 723 inline metadata — no virtualenv, no requirements.txt. Run them with `uv run`:

```bash
# Fetch transcripts (all episodes, ~10 min with rate limiting)
uv run fetch_transcripts.py

# Fetch only newest 3 episodes (for quick testing)
uv run fetch_transcripts.py --limit 3

# Build static site + Pagefind search index (requires Node.js/npx)
uv run build_index.py
```

There is no linter and no type checker configured.

### Testing

E2E tests use Puppeteer in a headless browser against a built `dist/`. Run via Make:

```bash
# For UI-only changes (fast — skips Pagefind indexing):
make build-without-index && make test

# Only needed when transcripts or episode HTML structure change:
make build && make test
```

`make test` auto-installs test deps (`cd tests && npm install`) then runs `node tests/test_search.mjs`. The test starts a local server on port 9222, launches Puppeteer, and validates search results, sorting, filtering, and snippet quality against the real Pagefind index.

## Architecture

### Pipeline (two scripts, no shared modules)

1. **`fetch_transcripts.py`** — Downloads the RSS feed, extracts `podcast:transcript` VTT URLs, and saves transcripts to `transcripts/{num:03d}.vtt`. Writes `meta.json` containing episode metadata and a global speaker list (sorted by cue frequency). Uses a `.vtt.missing` sentinel file to avoid re-checking episodes without transcripts.

2. **`build_index.py`** — Reads `meta.json` + VTT files, parses each VTT into speaker paragraphs, generates one HTML file per episode in `dist/episodes/`, copies `site/` into `dist/`, injects the speaker list into `dist/index.html`, then runs `npx pagefind` to build the client-side search index.

### Key data flow

```
RSS feed → fetch_transcripts.py → transcripts/*.vtt + meta.json
                                          ↓
meta.json + transcripts/*.vtt → build_index.py → dist/  (HTML + Pagefind index)
                                                       ↑
                                                    site/index.html (search UI)
```

### Frontend (`site/index.html`)

Single-page vanilla JS app. Loads Pagefind client-side, performs searches with debounce, and renders paragraph-level results with highlighted matches. Links to the original episode transcript pages using Text Fragment URLs (`#:~:text=...`).

### Deployment (`.github/workflows/deploy.yml`)

Runs daily at 06:00 UTC. Fetches new transcripts, commits them to `main`, builds the index, and deploys `dist/` to GitHub Pages.

## Conventions

- Scripts are self-contained single files with PEP 723 `# /// script` blocks for dependencies — no `pyproject.toml`.
- Transcript files are zero-padded 3-digit numbers: `001.vtt` through `550.vtt`.
- `dist/` is the build output (gitignored). `site/` contains the source static files.
- **Never** add `Co-Authored-By` trailers to commit messages.
