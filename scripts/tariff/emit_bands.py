"""Regenerate data/return-tariff.csv from the carrier tariff workbook.

Run from the repo root:  python3 scripts/tariff/emit_bands.py

The fee is the carrier's own price for that zone and weight, rounded UP to the
whole euro. Nothing is banded, anchored or subsidised — see the README beside
this file for why, and for how to refresh tarifas.xlsx when the carrier
republishes.
"""
import csv
import math
import os
import re
import zipfile
from xml.etree import ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
XLSX = os.path.join(HERE, "tarifas.xlsx")
OUT = os.path.join(ROOT, "data", "return-tariff.csv")

UNBOUNDED = 2147483647
NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

# (max_grams, the kg column to read the carrier price from). The last band is
# unbounded and priced from the 10kg column — heavier than any parcel seen.
BANDS = [(1000, 1), (2000, 2), (3000, 3), (5000, 5), (UNBOUNDED, 10)]

# Zones that are not a country of their own. Spain is one country and several
# carrier zones; resolveZone() in lib/zones.ts maps a postcode to these.
#
# Each maps to the MORE expensive of its candidate tariff rows, because a
# 2-digit postal prefix cannot separate them: 07 covers both Mallorca (8.08)
# and the minor Balearics (8.49), and both Canarian provinces hold a major
# island and minor ones (19.95 vs 21.15). Splitting further needs 3-digit
# ranges nobody has verified, and erring high keeps every row at or above cost.
SUB_ZONES = [
    ("ES-IB", "Baleares Menores", "terrestre"),
    ("ES-CN", "Islas de Canarias menores", "terrestre"),
    ("ES-CM", "Ceuta y Melilla", "terrestre"),
]

HEADER = [
    "country_code", "zone", "mode", "max_grams",
    "carrier_cost_cents", "return_fee_cents", "exchange_fee_cents",
]


def load_workbook():
    """Both tabs as {zone name: {kg: price string}}."""
    z = zipfile.ZipFile(XLSX)
    shared = [
        "".join(t.text or "" for t in si.iter(f"{NS}t"))
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall(f"{NS}si")
    ]

    def value(cell):
        v = cell.find(f"{NS}v")
        if cell.get("t") == "s" and v is not None:
            return shared[int(v.text)]
        return v.text if v is not None else ""

    def sheet(path):
        rows = []
        for r in ET.fromstring(z.read(path)).iter(f"{NS}row"):
            cells = {}
            for c in r.findall(f"{NS}c"):
                cells[re.match(r"([A-Z]+)", c.get("r") or "A").group(1)] = value(c)
            if cells:
                rows.append(cells)
        header = rows[0]
        bands = [
            (float(m.group(1)), col)
            for col, label in header.items()
            if col != "A" and (m := re.match(r"([\d.]+)\s*kg", label or ""))
        ]
        return {
            (r.get("A") or "").strip(): {kg: r.get(col, "") for kg, col in bands}
            for r in rows[1:]
            if (r.get("A") or "").strip()
        }

    return sheet("xl/worksheets/sheet1.xml"), sheet("xl/worksheets/sheet2.xml")


def main():
    terrestre, aereo = load_workbook()

    def cost_at(zone, kg):
        """Carrier price for a parcel of kg — the first band that holds it."""
        src = terrestre if zone in terrestre else aereo
        if zone not in src:
            raise SystemExit(f"zone {zone!r} is in neither tab of tarifas.xlsx")
        for band in sorted(src[zone]):
            if band >= kg - 1e-9 and src[zone][band]:
                return float(re.sub(r"[^0-9.]", "", src[zone][band]))
        priced = [b for b in sorted(src[zone]) if src[zone][b]]
        return float(re.sub(r"[^0-9.]", "", src[zone][priced[-1]]))

    # The destination -> tariff-zone mapping lives in the current CSV, because
    # it is a judgement call (which carrier zone a country belongs to) rather
    # than something derivable from the workbook. Consequence: this script
    # REPRICES existing destinations, it does not discover new ones. To add a
    # destination, append one row for it by hand, then re-run.
    with open(OUT, newline="") as fh:
        existing = list(csv.DictReader(fh))
    mapping = {}
    for row in existing:
        mapping.setdefault(row["country_code"], (row["zone"], row["mode"]))
    for key, zone, mode in SUB_ZONES:
        mapping.setdefault(key, (zone, mode))

    out = [HEADER]
    for code in sorted(mapping):
        zone, mode = mapping[code]
        previous = 0
        for max_grams, kg in BANDS:
            cost = cost_at(zone, kg)
            fee = math.ceil(cost) * 100
            # The tariff is not perfectly monotonic — Israel quotes 133.51 at
            # 3kg and 133.46 at 5kg — so clamp rather than let a fee fall as
            # the parcel gets heavier.
            fee = max(fee, previous)
            previous = fee
            out.append([code, zone, mode, max_grams, round(cost * 100), fee, fee - 100])

    with open(OUT, "w", newline="") as fh:
        # csv.writer defaults to CRLF. The repo is LF, and without this every
        # regeneration shows up as a 230-line diff that is purely line endings.
        csv.writer(fh, lineterminator="\n").writerows(out)

    zones = len(mapping)
    print(f"wrote {len(out) - 1} rows ({zones} destinations x {len(BANDS)} bands) -> {OUT}")
    print("run `npm test` to check coverage, then seed with")
    print("  npx tsx scripts/seed-shipping-fees-by-country.ts --dry-run")


if __name__ == "__main__":
    main()
