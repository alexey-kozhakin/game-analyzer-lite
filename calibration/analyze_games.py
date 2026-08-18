"""Compute per-side ACPL (average centipawn loss) for every downloaded game.

Mirrors the exact evaluation logic used by the app (src/main.js): one
Stockfish search per ply at a fixed depth, reusing each ply's analysis as
the "before" score for the next ply. Both the mover's ACPL and the known
Chess.com rating (at the time of that game) are written to a CSV that
calibrate.py consumes.

Usage:
    python analyze_games.py
    python analyze_games.py --depth 12 --stockfish-path /opt/homebrew/bin/stockfish
    python analyze_games.py --limit 50   # quick smoke test, first 50 games per file
"""
import argparse
import csv
import io
import json
import math
from pathlib import Path

import chess
import chess.engine
import chess.pgn

DATA_DIR = Path(__file__).parent / "data"
RAW_DIR = DATA_DIR / "raw"
DEFAULT_OUT = DATA_DIR / "dataset.csv"
CSV_FIELDS = ["url", "end_time", "color", "username", "rating", "opponent_username", "opponent_rating",
              "acpl", "accuracy", "ply_count"]


def score_cp(pov_score):
    return pov_score.score(mate_score=100000)


def win_percent(cp):
    # Mirrors winPercent() in src/main.js (Sadler/Regan win% formula).
    capped = max(-1000, min(1000, cp))
    return 50 + 50 * (2 / (1 + math.exp(-0.00368208 * capped)) - 1)


def move_accuracy_from_win_diff(win_diff):
    # Mirrors moveAccuracyFromWinDiff() in src/main.js.
    return max(0, min(100, 103.1668 * math.exp(-0.04354 * win_diff) - 3.1669))


def harmonic_mean(values):
    if not values:
        return 0
    return len(values) / sum(1 / max(v, 0.01) for v in values)


def side_accuracy(move_accuracies):
    if not move_accuracies:
        return 100.0
    return (sum(move_accuracies) / len(move_accuracies) + harmonic_mean(move_accuracies)) / 2


def analyse_game(engine, depth, pgn_text):
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        return None
    board = game.board()
    moves = list(game.mainline_moves())
    if not moves:
        return None

    losses = {chess.WHITE: [], chess.BLACK: []}
    move_accuracies = {chess.WHITE: [], chess.BLACK: []}
    prev_score = engine.analyse(board, chess.engine.Limit(depth=depth))["score"]
    for move in moves:
        mover = board.turn
        before = score_cp(prev_score.pov(mover))
        board.push(move)
        info = engine.analyse(board, chess.engine.Limit(depth=depth))
        after_score = info["score"]
        after = score_cp(after_score.pov(mover))
        prev_score = after_score
        losses[mover].append(max(0, before - after))
        win_diff = max(0, win_percent(before) - win_percent(after))
        move_accuracies[mover].append(move_accuracy_from_win_diff(win_diff))
    return losses, move_accuracies


def load_processed_urls(out_path):
    if not out_path.exists():
        return set()
    with out_path.open(newline="") as file:
        return {row["url"] for row in csv.DictReader(file)}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--depth", type=int, default=12, help="Stockfish search depth (default: 12, matches the app)")
    parser.add_argument("--stockfish-path", default="stockfish", help="Path to the Stockfish binary")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output CSV path")
    parser.add_argument("--limit", type=int, default=None, help="Only analyse the first N games per input file (testing)")
    args = parser.parse_args()

    raw_files = sorted(RAW_DIR.glob("*.json"))
    if not raw_files:
        raise SystemExit(f"No raw game files found in {RAW_DIR}. Run fetch_games.py first.")

    processed = load_processed_urls(args.out)
    write_header = not args.out.exists()
    args.out.parent.mkdir(parents=True, exist_ok=True)

    engine = chess.engine.SimpleEngine.popen_uci(args.stockfish_path)
    total_written = 0
    try:
        with args.out.open("a", newline="") as out_file:
            writer = csv.DictWriter(out_file, fieldnames=CSV_FIELDS)
            if write_header:
                writer.writeheader()
            for raw_file in raw_files:
                games = json.loads(raw_file.read_text())
                if args.limit:
                    games = games[: args.limit]
                print(f"{raw_file.name}: {len(games)} games")
                for index, game in enumerate(games, start=1):
                    if game["url"] in processed:
                        continue
                    try:
                        result = analyse_game(engine, args.depth, game["pgn"])
                    except Exception as error:  # malformed PGN, engine hiccup, etc.
                        print(f"  [{index}/{len(games)}] skipped {game['url']}: {error}")
                        continue
                    if result is None:
                        continue
                    losses, move_accuracies = result
                    for color, side_key in ((chess.WHITE, "white"), (chess.BLACK, "black")):
                        side_losses = losses[color]
                        if not side_losses:
                            continue
                        opponent_key = "black" if side_key == "white" else "white"
                        writer.writerow({
                            "url": game["url"],
                            "end_time": game["end_time"],
                            "color": side_key,
                            "username": game[side_key]["username"],
                            "rating": game[side_key]["rating"],
                            "opponent_username": game[opponent_key]["username"],
                            "opponent_rating": game[opponent_key]["rating"],
                            "acpl": sum(side_losses) / len(side_losses),
                            "accuracy": side_accuracy(move_accuracies[color]),
                            "ply_count": len(side_losses),
                        })
                        total_written += 1
                    processed.add(game["url"])
                    out_file.flush()
                    print(f"  [{index}/{len(games)}] {game['url']} done")
    finally:
        engine.quit()
    print(f"Wrote {total_written} side-rows to {args.out}")


if __name__ == "__main__":
    main()
