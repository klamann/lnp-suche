#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "requests>=2.31.0",
#   "typer[all]>=0.12.0",
#   "feedparser>=6.0.11",
# ]
# ///
"""Download WEBVTT transcripts from Logbuch:Netzpolitik podcast RSS feed."""

from __future__ import annotations

import json
import re
import time
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import feedparser
import requests
import typer
from rich.progress import BarColumn, MofNCompleteColumn, Progress, TextColumn, TimeRemainingColumn

FEED_URL = "https://logbuch-netzpolitik.de/feed/mp3"

CUE_PATTERN = re.compile(r"\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}")


@dataclass
class Episode:
    number: int
    title: str
    transcript_url: str | None
    url: str       # episode page URL from RSS <link>
    date: str      # ISO date YYYY-MM-DD from RSS pubDate


def has_cues(webvtt_text: str) -> bool:
    return bool(CUE_PATTERN.search(webvtt_text))


def fetch_feed(
    timeout: float, feed_file: Path | None
) -> tuple[feedparser.FeedParserDict, bytes]:
    resp = requests.get(FEED_URL, timeout=timeout)
    resp.raise_for_status()
    raw = resp.content
    if feed_file is not None:
        feed_file.parent.mkdir(parents=True, exist_ok=True)
        feed_file.write_bytes(raw)
        print(f"Feed saved to {feed_file}")
    feed = feedparser.parse(raw)
    return feed, raw


def _extract_transcript_urls_via_xml(raw_xml: bytes) -> dict[str, str]:
    """Fallback: extract podcast:transcript VTT URLs from raw XML by episode number."""
    url_by_episode: dict[str, str] = {}
    root = ET.fromstring(raw_xml)
    ns = {
        "podcast": "https://podcastindex.org/namespace/1.0",
        "itunes": "http://www.itunes.com/dtds/podcast-1.0.dtd",
    }
    for item in root.iter("item"):
        ep_el = item.find("itunes:episode", ns)
        if ep_el is None or not ep_el.text:
            continue
        ep_num = ep_el.text.strip()
        for transcript in item.findall("podcast:transcript", ns):
            if transcript.get("type") == "text/vtt":
                url = transcript.get("url")
                if url:
                    url_by_episode[ep_num] = url
                    break
    return url_by_episode


def parse_episodes(
    feed: feedparser.FeedParserDict, raw_xml: bytes
) -> list[Episode]:
    # Build XML-based transcript map as fallback
    xml_transcripts = _extract_transcript_urls_via_xml(raw_xml)

    episodes: list[Episode] = []
    for entry in feed.entries:
        ep_str = entry.get("itunes_episode")
        if not ep_str:
            continue
        try:
            number = int(ep_str)
        except ValueError:
            continue

        title = entry.get("title", "")

        # Try feedparser's podcast_transcript first
        transcript_url: str | None = None
        fp_transcripts = entry.get("podcast_transcript") or entry.get(
            "podcast:transcript"
        )
        if fp_transcripts:
            # feedparser may store as list of dicts or similar
            items = fp_transcripts if isinstance(fp_transcripts, list) else [fp_transcripts]
            for t in items:
                if isinstance(t, dict) and t.get("type") == "text/vtt":
                    transcript_url = t.get("url") or t.get("href")
                    break

        # Fallback to XML extraction
        if transcript_url is None:
            transcript_url = xml_transcripts.get(ep_str)

        url = entry.get("link", "")
        published_parsed = entry.get("published_parsed")
        date = time.strftime("%Y-%m-%d", published_parsed) if published_parsed else ""

        episodes.append(Episode(number=number, title=title, transcript_url=transcript_url, url=url, date=date))

    return episodes


def download_transcripts(
    episodes: list[Episode],
    output_dir: Path,
    pause: float,
    timeout: float,
    limit: int,
) -> None:
    total = len(episodes)
    episodes.sort(key=lambda e: e.number, reverse=True)
    if limit > 0:
        episodes = episodes[:limit]
    status_label = f"[{len(episodes)}/{total}]" if limit > 0 else f"[{total}]"

    output_dir.mkdir(parents=True, exist_ok=True)
    session = requests.Session()

    downloaded = 0
    skipped = 0
    missing = 0
    errors = 0

    # Separate episodes that need work from those we can skip instantly
    todo: list[Episode] = []
    for ep in episodes:
        vtt_path = output_dir / f"{ep.number:03d}.vtt"
        missing_path = output_dir / f"{ep.number:03d}.vtt.missing"
        if (vtt_path.exists() and vtt_path.stat().st_size > 0) or missing_path.exists():
            skipped += 1
        else:
            todo.append(ep)

    if skipped:
        print(f"  Skipped {skipped} already downloaded")

    if not todo:
        print("  Nothing to download")
        print(f"\nSummary: {downloaded} downloaded, {skipped} skipped, {missing} missing, {errors} errors")
        return

    progress = Progress(
        TextColumn("[bold]{task.fields[status]}"),
        BarColumn(),
        MofNCompleteColumn(),
        TextColumn("ETA"),
        TimeRemainingColumn(),
        TextColumn("{task.description}"),
    )
    task = progress.add_task("", total=len(todo), status=status_label)

    with progress:
        for ep in todo:
            vtt_path = output_dir / f"{ep.number:03d}.vtt"
            missing_path = output_dir / f"{ep.number:03d}.vtt.missing"

            if ep.transcript_url is None:
                missing_path.touch()
                missing += 1
                progress.update(task, advance=1, description=f"EP {ep.number:03d} — no transcript")
                continue

            try:
                resp = session.get(ep.transcript_url, timeout=timeout)
                resp.raise_for_status()
                text = resp.text

                if not text.strip() or not has_cues(text):
                    missing_path.touch()
                    missing += 1
                    progress.update(task, advance=1, description=f"EP {ep.number:03d} — no cues")
                else:
                    vtt_path.write_text(text, encoding="utf-8")
                    downloaded += 1
                    progress.update(
                        task, advance=1, description=f"EP {ep.number:03d} — {len(text) / 1024:.1f} KB"
                    )

                time.sleep(pause)

            except Exception as exc:
                errors += 1
                progress.update(task, advance=1, description=f"EP {ep.number:03d} — error: {exc}")

    print(
        f"\nSummary: {downloaded} downloaded, {skipped} skipped, "
        f"{missing} missing, {errors} errors"
    )


VOICE_TAG_RE = re.compile(r"<v\s+([^>]+)>")


def collect_speakers(output_dir: Path) -> list[dict]:
    """Scan all VTT files and count cues per speaker, sorted by frequency."""
    counts: dict[str, int] = {}
    for vtt_path in sorted(output_dir.glob("*.vtt")):
        for line in vtt_path.read_text(encoding="utf-8").splitlines():
            m = VOICE_TAG_RE.search(line)
            if m:
                counts[m.group(1)] = counts.get(m.group(1), 0) + 1
    return [
        {"name": name, "cue_count": count}
        for name, count in sorted(counts.items(), key=lambda x: x[1], reverse=True)
    ]


def write_metadata(episodes: list[Episode], metadata_file: Path, output_dir: Path) -> None:
    episode_data = []
    for ep in sorted(episodes, key=lambda e: e.number, reverse=True):
        vtt_path = output_dir / f"{ep.number:03d}.vtt"
        has_transcript = vtt_path.exists() and vtt_path.stat().st_size > 0
        episode_data.append({
            "number": ep.number,
            "title": ep.title,
            "url": ep.url,
            "date": ep.date,
            "has_transcript": has_transcript,
        })
    speakers = collect_speakers(output_dir)
    data = {
        "episodes": episode_data,
        "speakers": speakers,
    }
    metadata_file.parent.mkdir(parents=True, exist_ok=True)
    metadata_file.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Metadata written to {metadata_file} ({len(episode_data)} episodes, {len(speakers)} speakers)")


def main(
    output_dir: Path = typer.Option(Path("transcripts"), help="Folder for .vtt files"),
    pause: float = typer.Option(1.0, help="Seconds between downloads"),
    timeout: float = typer.Option(30.0, help="HTTP request timeout in seconds"),
    limit: int = typer.Option(0, help="Max episodes to process (0 = all)"),
    feed_file: Optional[Path] = typer.Option(None, help="Save RSS XML to this path"),
    metadata_file: Optional[Path] = typer.Option(
        Path("meta.json"), help="Write episode metadata JSON to this path"
    ),
) -> None:
    print(f"Fetching feed from {FEED_URL} ...")
    feed, raw_xml = fetch_feed(timeout=timeout, feed_file=feed_file)
    print(f"Feed contains {len(feed.entries)} items")

    episodes = parse_episodes(feed, raw_xml)
    print(f"Found {len(episodes)} episodes with numbers")

    print(f"Downloading transcripts to {output_dir}/ ...")
    download_transcripts(episodes, output_dir, pause, timeout, limit)

    if metadata_file is not None:
        write_metadata(episodes, metadata_file, output_dir)


if __name__ == "__main__":
    typer.run(main)
