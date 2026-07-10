#!/usr/bin/env python3

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import edge_tts

TICKS_PER_SECOND = 10_000_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate Edge TTS audio with word-boundary timing data.")
    parser.add_argument("--voice", required=True)
    parser.add_argument("--rate", required=True)
    parser.add_argument("--write-media", required=True)
    parser.add_argument("--write-boundaries", required=True)
    return parser.parse_args()


async def generate(args: argparse.Namespace, text: str) -> None:
    media_path = Path(args.write_media)
    boundaries_path = Path(args.write_boundaries)
    media_path.parent.mkdir(parents=True, exist_ok=True)
    boundaries_path.parent.mkdir(parents=True, exist_ok=True)

    media_tmp = Path(f"{media_path}.tmp")
    boundaries_tmp = Path(f"{boundaries_path}.tmp")
    words = []

    try:
        communicate = edge_tts.Communicate(
            text,
            args.voice,
            rate=args.rate,
            boundary="WordBoundary",
        )
        with media_tmp.open("wb") as media:
            async for chunk in communicate.stream():
                if chunk["type"] == "audio":
                    media.write(chunk["data"])
                elif chunk["type"] == "WordBoundary":
                    start = chunk["offset"] / TICKS_PER_SECOND
                    end = (chunk["offset"] + chunk["duration"]) / TICKS_PER_SECOND
                    words.append({
                        "text": chunk["text"],
                        "start": round(start, 6),
                        "end": round(end, 6),
                    })

        if not words:
            raise RuntimeError("Edge TTS returned no word-boundary metadata")

        payload = {
            "version": 1,
            "voice": args.voice,
            "rate": args.rate,
            "text": text,
            "words": words,
        }
        boundaries_tmp.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(media_tmp, media_path)
        os.replace(boundaries_tmp, boundaries_path)
    finally:
        media_tmp.unlink(missing_ok=True)
        boundaries_tmp.unlink(missing_ok=True)


def main() -> None:
    args = parse_args()
    text = sys.stdin.read().strip()
    if not text:
        raise ValueError("Expected sentence text on stdin")
    asyncio.run(generate(args, text))


if __name__ == "__main__":
    main()
