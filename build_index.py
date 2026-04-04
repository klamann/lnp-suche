#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Convert VTT transcripts to HTML pages and run Pagefind to build a search index."""

from __future__ import annotations

import argparse
import html
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

TIMESTAMP_RE = re.compile(r"(\d{2}:\d{2}:\d{2})\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}")
VOICE_TAG_RE = re.compile(r"<v\s+([^>]+)>")
CLOSE_VOICE_RE = re.compile(r"</v>")


def parse_vtt(path: Path) -> list[dict]:
    """Parse a VTT file into a list of speaker paragraphs.

    Returns a list of dicts with keys: speaker, text, timestamp.
    Consecutive cues by the same speaker are merged into one paragraph.
    """
    content = path.read_text(encoding="utf-8")
    blocks = re.split(r"\n\n+", content.strip())

    cues: list[dict] = []
    for block in blocks:
        lines = block.strip().splitlines()
        if not lines:
            continue
        # Skip WEBVTT header and NOTE blocks
        if lines[0].startswith("WEBVTT") or lines[0].startswith("NOTE"):
            continue

        # Find the timestamp line
        timestamp_match = None
        timestamp_line_idx = -1
        for i, line in enumerate(lines):
            timestamp_match = TIMESTAMP_RE.search(line)
            if timestamp_match:
                timestamp_line_idx = i
                break

        if not timestamp_match:
            continue

        start_time = timestamp_match.group(1)

        # Text lines are everything after the timestamp line
        text_lines = lines[timestamp_line_idx + 1 :]
        if not text_lines:
            continue

        # Extract speaker from <v SpeakerName> tag and strip tags
        speaker = ""
        cleaned_lines = []
        for tl in text_lines:
            voice_match = VOICE_TAG_RE.search(tl)
            if voice_match:
                speaker = voice_match.group(1)
            cleaned = VOICE_TAG_RE.sub("", tl)
            cleaned = CLOSE_VOICE_RE.sub("", cleaned)
            cleaned_lines.append(cleaned.strip())

        text = " ".join(cleaned_lines).strip()
        if text:
            cues.append({"speaker": speaker, "text": text, "timestamp": start_time})

    # Group consecutive cues by same speaker into paragraphs
    if not cues:
        return []

    paragraphs: list[dict] = []
    current = {
        "speaker": cues[0]["speaker"],
        "text": cues[0]["text"],
        "timestamp": cues[0]["timestamp"],
    }

    for cue in cues[1:]:
        if cue["speaker"] == current["speaker"]:
            current["text"] += " " + cue["text"]
        else:
            paragraphs.append(current)
            current = {
                "speaker": cue["speaker"],
                "text": cue["text"],
                "timestamp": cue["timestamp"],
            }
    paragraphs.append(current)

    return paragraphs


def generate_episode_html(episode: dict, paragraphs: list[dict]) -> str:
    """Generate an HTML page for a single episode with Pagefind metadata."""
    title = html.escape(episode["title"])
    number = html.escape(str(episode["number"]))
    url = html.escape(episode.get("url", ""))
    date = html.escape(episode.get("date", ""))

    parts = [
        '<!DOCTYPE html>',
        '<html lang="de">',
        f'<head><meta charset="utf-8"><title>{title}</title></head>',
        '<body>',
        '<div data-pagefind-body>',
        f'  <h1 data-pagefind-meta="title">{title}</h1>',
        f'  <div data-pagefind-ignore style="display:none">',
        f'    <span data-pagefind-meta="number">{number}</span>',
        f'    <span data-pagefind-meta="url">{url}</span>',
        f'    <span data-pagefind-meta="date">{date}</span>',
        f'  </div>',
    ]

    for i, para in enumerate(paragraphs):
        ts = html.escape(para["timestamp"])
        speaker = html.escape(para["speaker"])
        text = html.escape(para["text"])
        parts.append(f'  <h6 id="p{i}" data-pagefind-weight="0">{speaker}</h6>')
        parts.append(f'  <p data-timestamp="{ts}">{text}</p>')

    parts.extend([
        '</div>',
        '</body>',
        '</html>',
    ])

    return "\n".join(parts) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Convert VTT transcripts to HTML and build Pagefind search index."
    )
    parser.add_argument(
        "--metadata-file", default="episodes.json", help="Episode metadata JSON (default: episodes.json)"
    )
    parser.add_argument(
        "--transcripts-dir", default="transcripts", help="VTT files directory (default: transcripts)"
    )
    parser.add_argument(
        "--site-dir", default="site", help="Static site source files (default: site)"
    )
    parser.add_argument(
        "--dist-dir", default="dist", help="Output directory (default: dist)"
    )
    args = parser.parse_args()

    metadata_file = Path(args.metadata_file)
    transcripts_dir = Path(args.transcripts_dir)
    site_dir = Path(args.site_dir)
    dist_dir = Path(args.dist_dir)

    # 1. Read episodes.json
    if not metadata_file.exists():
        print(f"Error: metadata file not found: {metadata_file}", file=sys.stderr)
        sys.exit(1)

    episodes = json.loads(metadata_file.read_text(encoding="utf-8"))

    # 2. Clean and create dist directory
    if dist_dir.exists():
        shutil.rmtree(dist_dir)
    episodes_dir = dist_dir / "episodes"
    episodes_dir.mkdir(parents=True)

    # 3. Generate HTML for each episode with a transcript
    count = 0
    for episode in episodes:
        if not episode.get("has_transcript", False):
            continue

        num = episode["number"]
        vtt_path = transcripts_dir / f"{num:03d}.vtt"
        if not vtt_path.exists():
            print(f"Warning: VTT file not found for episode {num}: {vtt_path}", file=sys.stderr)
            continue

        paragraphs = parse_vtt(vtt_path)
        html_content = generate_episode_html(episode, paragraphs)
        out_path = episodes_dir / f"{num:03d}.html"
        out_path.write_text(html_content, encoding="utf-8")
        count += 1

    print(f"Generated {count} episode HTML files in {episodes_dir}")

    # 4. Copy site/ contents to dist/
    if site_dir.exists():
        for item in site_dir.iterdir():
            dest = dist_dir / item.name
            if item.is_dir():
                shutil.copytree(item, dest, dirs_exist_ok=True)
            else:
                shutil.copy2(item, dest)
        print(f"Copied site files from {site_dir} to {dist_dir}")
    else:
        print(f"Warning: site directory not found: {site_dir}", file=sys.stderr)

    # 5. Run Pagefind
    npx = shutil.which("npx")
    if npx is None and sys.platform == "win32":
        npx = shutil.which("npx.cmd")
    if npx is None:
        npx = "npx"

    cmd = [npx, "pagefind", "--site", str(dist_dir), "--force-language", "de"]
    print(f"Running: {' '.join(cmd)}")
    result = subprocess.run(cmd, check=True)


if __name__ == "__main__":
    main()
