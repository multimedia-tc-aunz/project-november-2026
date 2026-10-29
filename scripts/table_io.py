"""Write a table as both CSV and JSON (same name, same rows, same column order).

JSON is a list of objects, one per row. A column becomes numbers only if every
non-blank value in it is a plain number, so codes like FIPS "01" stay as text.
Blank cells become null.
"""
import csv
import json
import re

NUMBER = re.compile(r"-?(0|[1-9]\d*)(\.\d+)?")


def _numeric_columns(rows, cols):
    numeric = set()
    for c in cols:
        vals = [str(r[c]) for r in rows if r.get(c) not in ("", None)]
        if vals and all(NUMBER.fullmatch(v) for v in vals):
            numeric.add(c)
    return numeric


def _json_value(v, is_number):
    if v in ("", None):
        return None
    if is_number:
        f = float(v)
        return int(f) if f.is_integer() and "." not in str(v) else f
    return str(v)


def _atomic_write(path, write):
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", newline="", encoding="utf-8") as f:
        write(f)
    tmp.replace(path)  # atomic: readers never see a half-written file


def write_table(csv_path, rows):
    """Write rows to csv_path and to the same path with a .json extension."""
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    cols = list(rows[0])

    def write_csv(f):
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        w.writerows(rows)

    numeric = _numeric_columns(rows, cols)
    records = [{c: _json_value(r.get(c), c in numeric) for c in cols} for r in rows]

    def write_json(f):
        json.dump(records, f, ensure_ascii=False, indent=1)
        f.write("\n")

    _atomic_write(csv_path, write_csv)
    _atomic_write(csv_path.with_suffix(".json"), write_json)
