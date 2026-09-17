#!/usr/bin/env python3
"""How Klips is doing: visits, where people come from, the setup funnel, clips and revenue.

    scripts/stats.py            last 30 days
    scripts/stats.py 7          last 7 days

Reads the private owner key from ~/klips/.admin-token (never committed).
"""
from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

SITE = "https://klips.pro"
TOKEN_FILE = Path(__file__).resolve().parent.parent / ".admin-token"


def fetch(days: int) -> dict:
    request = urllib.request.Request(
        f"{SITE}/api/admin/stats?days={days}",
        headers={"x-klips-admin": TOKEN_FILE.read_text().strip(), "user-agent": "Klips-stats/1.0 (+https://klips.pro)"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode())


def table(title: str, rows: list, key: str, value: str) -> None:
    print(f"\n{title}")
    if not rows:
        print("  (nothing yet)")
        return
    width = max(len(str(r[key])) for r in rows)
    for r in rows:
        print(f"  {str(r[key]).ljust(width)}  {r[value]:>7,}")


def pct(part: int, whole: int) -> str:
    return f"{round(100 * part / whole)}%" if whole else "-"


def main() -> None:
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    s = fetch(days)
    visits = sum(d["views"] for d in s["daily"])
    f = {k: v or 0 for k, v in (s["funnel"] or {}).items()}
    print(f"Klips · last {days} days")
    print(f"\nPage views: {visits:,}")
    for d in s["daily"][-14:]:
        print(f"  {d['day']}  {'█' * max(1, round(40 * d['views'] / max(x['views'] for x in s['daily'])))} {d['views']}")

    signed = f.get("signed_up", 0)
    print("\nSetup funnel (people who signed up in this period)")
    for label, key in [("Signed up", "signed_up"), ("Chose free or paid", "chose_plan"), ("Installed Klips Engine", "installed_engine"),
                       ("Made clips", "made_clips"), ("Paid", "paid")]:
        print(f"  {label:<24} {f.get(key, 0):>6,}  {pct(f.get(key, 0), signed)}")

    rev = s["revenue"] or {}
    clips = s["clips"] or {}
    print(f"\nRevenue: ${rev.get('cents', 0) / 100:,.2f} from {rev.get('purchases', 0)} payments")
    print(f"Clips made: {clips.get('free_clips', 0):,} free, {clips.get('paid_clips', 0):,} paid")

    table("Sign-ups by source", s["signups_by_source"], "origin", "signups")
    table("Top referring sites", s["referrers"], "referrer", "views")
    table("Campaign tags (?utm_source= or ?ref=)", s["sources"], "source", "views")
    table("Top pages", s["pages"], "path", "views")
    table("Countries", s["countries"], "country", "views")


if __name__ == "__main__":
    main()
