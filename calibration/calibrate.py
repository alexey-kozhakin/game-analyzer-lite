"""Fit A, B, C in estimatedElo(acpl) = clamp(A - B * ln(1 + acpl / C), 400, 2900)
against real Chess.com ratings recorded at the time each game was played.

Two-stage fit:
  1. Grid-search C; for each candidate, A and B have a closed-form solution
     (ordinary least squares on rating ~ A - B * ln(1 + acpl / C)), since the
     model is linear in A and B once C is fixed.
  2. Optional PyTorch gradient refinement of all three parameters jointly,
     starting from the grid-search winner.

Usage:
    python calibrate.py
    python calibrate.py --method grid       # skip the PyTorch refinement step
    python calibrate.py --test-split 0.2    # held-out MAE to sanity-check overfitting
"""
import argparse
import csv
import json
from pathlib import Path

import numpy as np

DATA_DIR = Path(__file__).parent / "data"
DEFAULT_DATASET = DATA_DIR / "dataset.csv"
DEFAULT_OUT = DATA_DIR / "calibration_result.json"


def load_dataset(path):
    acpl, rating = [], []
    with path.open(newline="") as file:
        for row in csv.DictReader(file):
            acpl.append(float(row["acpl"]))
            rating.append(float(row["rating"]))
    return np.array(acpl), np.array(rating)


def predict(acpl, a, b, c):
    return np.clip(a - b * np.log1p(acpl / c), 400, 2900)


def grid_search(acpl, rating, c_grid):
    best = None
    for c in c_grid:
        x = np.log1p(acpl / c)
        design = np.column_stack([np.ones_like(x), x])
        coeffs, *_ = np.linalg.lstsq(design, rating, rcond=None)
        a, b = coeffs[0], -coeffs[1]
        mse = float(np.mean((predict(acpl, a, b, c) - rating) ** 2))
        if best is None or mse < best["mse"]:
            best = {"a": float(a), "b": float(b), "c": float(c), "mse": mse}
    return best


def grid_search_c_only(acpl, rating, c_grid, a, b):
    best = None
    for c in c_grid:
        mse = float(np.mean((predict(acpl, a, b, c) - rating) ** 2))
        if best is None or mse < best["mse"]:
            best = {"a": float(a), "b": float(b), "c": float(c), "mse": mse}
    return best


def torch_refine(acpl, rating, init, epochs=2000, lr=5.0):
    import torch

    acpl_t = torch.tensor(acpl, dtype=torch.float64)
    rating_t = torch.tensor(rating, dtype=torch.float64)
    a = torch.tensor(init["a"], dtype=torch.float64, requires_grad=True)
    b = torch.tensor(init["b"], dtype=torch.float64, requires_grad=True)
    c = torch.tensor(init["c"], dtype=torch.float64, requires_grad=True)

    optimizer = torch.optim.Adam([a, b, c], lr=lr)
    for epoch in range(epochs):
        optimizer.zero_grad()
        c_safe = torch.clamp(c, min=0.5)  # keep the log argument well-defined
        pred = torch.clamp(a - b * torch.log1p(acpl_t / c_safe), 400, 2900)
        loss = torch.mean((pred - rating_t) ** 2)
        loss.backward()
        optimizer.step()
        if epoch % 500 == 0 or epoch == epochs - 1:
            print(f"  epoch {epoch:5d}  mse={loss.item():.2f}  A={a.item():.2f} B={b.item():.2f} C={c.item():.2f}")

    return {"a": float(a.item()), "b": float(b.item()), "c": float(max(c.item(), 0.5))}


def torch_refine_c_only(acpl, rating, init, epochs=2000, lr=5.0):
    import torch

    acpl_t = torch.tensor(acpl, dtype=torch.float64)
    rating_t = torch.tensor(rating, dtype=torch.float64)
    a = torch.tensor(init["a"], dtype=torch.float64)
    b = torch.tensor(init["b"], dtype=torch.float64)
    c = torch.tensor(init["c"], dtype=torch.float64, requires_grad=True)

    optimizer = torch.optim.Adam([c], lr=lr)
    for epoch in range(epochs):
        optimizer.zero_grad()
        c_safe = torch.clamp(c, min=0.5)
        pred = torch.clamp(a - b * torch.log1p(acpl_t / c_safe), 400, 2900)
        loss = torch.mean((pred - rating_t) ** 2)
        loss.backward()
        optimizer.step()
        if epoch % 500 == 0 or epoch == epochs - 1:
            print(f"  epoch {epoch:5d}  mse={loss.item():.2f}  C={c.item():.2f} (A={a.item():.2f}, B={b.item():.2f} fixed)")

    return {"a": float(a.item()), "b": float(b.item()), "c": float(max(c.item(), 0.5))}


def evaluate(acpl, rating, params, label):
    pred = predict(acpl, params["a"], params["b"], params["c"])
    mse = float(np.mean((pred - rating) ** 2))
    mae = float(np.mean(np.abs(pred - rating)))
    print(f"{label}: A={params['a']:.2f} B={params['b']:.2f} C={params['c']:.2f}  "
          f"MSE={mse:.1f}  MAE={mae:.1f}  RMSE={mse ** 0.5:.1f}")
    return {"mse": mse, "mae": mae}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--method", choices=["grid", "torch", "both"], default="both")
    parser.add_argument("--test-split", type=float, default=0.2, help="Fraction held out to report generalization MAE")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--fix-a", type=float, default=None, help="Freeze A to this value and only fit C (requires --fix-b too)")
    parser.add_argument("--fix-b", type=float, default=None, help="Freeze B to this value and only fit C (requires --fix-a too)")
    args = parser.parse_args()
    if (args.fix_a is None) != (args.fix_b is None):
        parser.error("--fix-a and --fix-b must be given together")

    if not args.dataset.exists():
        raise SystemExit(f"{args.dataset} not found. Run fetch_games.py then analyze_games.py first.")

    acpl, rating = load_dataset(args.dataset)
    print(f"Loaded {len(acpl)} (acpl, rating) samples. "
          f"ACPL range: {acpl.min():.0f}-{acpl.max():.0f}, rating range: {rating.min():.0f}-{rating.max():.0f}")

    rng = np.random.default_rng(args.seed)
    order = rng.permutation(len(acpl))
    split = int(len(acpl) * (1 - args.test_split)) if args.test_split else len(acpl)
    train_idx, test_idx = order[:split], order[split:]
    acpl_train, rating_train = acpl[train_idx], rating[train_idx]

    c_grid = np.geomspace(1, 300, 80)
    fixed_ab = args.fix_a is not None
    if fixed_ab:
        print(f"Fixing A={args.fix_a}, B={args.fix_b}; fitting C only.")
        best = grid_search_c_only(acpl_train, rating_train, c_grid, args.fix_a, args.fix_b)
    else:
        best = grid_search(acpl_train, rating_train, c_grid)
    evaluate(acpl_train, rating_train, best, "Grid search (train)")

    final = best
    if args.method in ("torch", "both"):
        print("Refining with PyTorch (Adam)...")
        final = torch_refine_c_only(acpl_train, rating_train, best) if fixed_ab else torch_refine(acpl_train, rating_train, best)
        evaluate(acpl_train, rating_train, final, "Torch refined (train)")

    if len(test_idx):
        evaluate(acpl[test_idx], rating[test_idx], final, "Held-out test")

    result = {
        "a": round(final["a"], 2),
        "b": round(final["b"], 2),
        "c": round(final["c"], 2),
        "n_samples": int(len(acpl)),
        "acpl_range": [float(acpl.min()), float(acpl.max())],
        "rating_range": [float(rating.min()), float(rating.max())],
    }
    args.out.write_text(json.dumps(result, indent=2))
    print(f"\nSaved calibration to {args.out}")
    print(f"JS snippet: estimatedElo = Math.round(Math.max(400, Math.min(2900, "
          f"{result['a']} - {result['b']} * Math.log(1 + acpl / {result['c']}))))")


if __name__ == "__main__":
    main()
