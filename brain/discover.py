"""Find the MaleCNS cell types the instinct tests need: senses in, commands out.

Run from the fly-wirehead runtime so its data/ and venv are used:
    cd "${CYBERFLY_RUNTIME:-$HOME/cyberfly_runtime}/fly-wirehead" && uv run python "<this file>"
"""

import re

import pyarrow.feather as feather

from flywirehead.neural.common import DATA

a = feather.read_table(DATA / "annotations.feather").to_pandas()
print("columns:", list(a.columns))
t = a["type"].fillna("")

PATTERNS = {
    "olfactory (ORN)": r"^ORN|^OR\d|Or\d{2}",
    "gustatory / sugar": r"^GRN|Gr5|Gr64|^LB\d|sugar|^gust",
    "looming (LPLC2/LC4)": r"^LPLC2$|^LC4$",
    "giant fiber": r"^DNp01$|[Gg]iant",
    "steering DNa01/02": r"^DNa0[12]$",
    "walk DNp09 / MDN": r"^DNp09$|^MDN$",
    "feeding MN9": r"^MN9$",
    "doomfly BCI": r"^DNp20$|^DNpe017$",
}

for label, pattern in PATTERNS.items():
    hit = a[t.str.contains(pattern, regex=True)]
    print(f"\n== {label}: {len(hit)} cells")
    if len(hit):
        g = hit.groupby(["type", hit["somaSide"].fillna("?")]).size()
        for (typ, side), n in list(g.items())[:40]:
            print(f"   {typ:<18} side={side:<3} n={n}")

sc = a["superclass"].fillna("")
print("\n== superclasses containing sensory:")
print(a[sc.str.contains("sensory", case=False)]["superclass"].value_counts().head(20))
