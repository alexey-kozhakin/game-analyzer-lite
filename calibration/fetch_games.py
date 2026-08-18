"""Download rapid games (with PGN + ratings) from the Chess.com public API.

Usage:
    python fetch_games.py --username alexey-kozhakin
    python fetch_games.py --username alexey-kozhakin --username some-other-player
    python fetch_games.py --username alexey-kozhakin --months-limit 6 --force

Saves one JSON file per username to data/raw/<username>.json containing a
list of trimmed game records (pgn, ratings, result, url, end_time).
"""
import argparse
import json
import sys
import time
from pathlib import Path

import requests

API_ROOT = "https://api.chess.com/pub/player"
# Chess.com asks API consumers to identify themselves with a contact-bearing User-Agent.
HEADERS = {"User-Agent": "game-analyzer-lite-calibration/1.0 (personal research script)"}
DATA_DIR = Path(__file__).parent / "data" / "raw"


def fetch_archives(username):
    response = requests.get(f"{API_ROOT}/{username}/games/archives", headers=HEADERS, timeout=20)
    response.raise_for_status()
    return response.json()["archives"]


def fetch_month(archive_url):
    response = requests.get(archive_url, headers=HEADERS, timeout=20)
    if not response.ok:
        return []
    return response.json().get("games", [])


def trim_game(game):
    return {
        "url": game.get("url"),
        "end_time": game.get("end_time"),
        "time_class": game.get("time_class"),
        "pgn": game.get("pgn"),
        "white": {
            "username": game["white"]["username"],
            "rating": game["white"]["rating"],
            "result": game["white"]["result"],
        },
        "black": {
            "username": game["black"]["username"],
            "rating": game["black"]["rating"],
            "result": game["black"]["result"],
        },
    }


def fetch_all_games(username, time_class, months_limit):
    archives = fetch_archives(username)
    if months_limit:
        archives = archives[-months_limit:]
    games = []
    for index, archive_url in enumerate(archives, start=1):
        month_games = fetch_month(archive_url)
        filtered = [trim_game(g) for g in month_games if g.get("time_class") == time_class and g.get("pgn")]
        games.extend(filtered)
        print(f"  [{index}/{len(archives)}] {archive_url.split('/')[-2]}-{archive_url.split('/')[-1]}: "
              f"{len(filtered)} {time_class} games (total so far: {len(games)})")
        time.sleep(0.3)  # be polite to the free public API
    return games


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--username", action="append", required=True, dest="usernames",
                         help="Chess.com username to fetch. Repeat for multiple players.")
    parser.add_argument("--time-class", default="rapid", help="Time class to keep (default: rapid)")
    parser.add_argument("--months-limit", type=int, default=None,
                         help="Only fetch the N most recent months per user (default: all history)")
    parser.add_argument("--force", action="store_true", help="Re-fetch even if the output file already exists")
    args = parser.parse_args()

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for username in args.usernames:
        out_path = DATA_DIR / f"{username.lower()}.json"
        if out_path.exists() and not args.force:
            print(f"Skipping {username}: {out_path} already exists (use --force to re-fetch)")
            continue
        print(f"Fetching {args.time_class} games for {username}...")
        try:
            games = fetch_all_games(username, args.time_class, args.months_limit)
        except requests.HTTPError as error:
            print(f"  Failed to fetch {username}: {error}", file=sys.stderr)
            continue
        out_path.write_text(json.dumps(games, ensure_ascii=False, indent=1))
        print(f"  Saved {len(games)} games to {out_path}")


if __name__ == "__main__":
    main()
