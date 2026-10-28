#!/bin/sh
# Re-download the pre-election sources and rebuild the Senate base table.
# Run this on election morning so ratings, candidates and senators are current.
set -e
cd "$(dirname "$0")/.."
RAW=data/raw
UA="midterms-data-prep/1.0"
curl -sf -A "$UA" -o $RAW/wiki-senate.json "https://en.wikipedia.org/w/api.php?action=parse&page=2026_United_States_Senate_elections&prop=wikitext&format=json&formatversion=2"
curl -sf -o $RAW/legislators-current.json "https://unitedstates.github.io/congress-legislators/legislators-current.json"
curl -sf -A "$UA" -o $RAW/wiki-pvi.json "https://en.wikipedia.org/w/api.php?action=parse&page=Cook_Partisan_Voting_Index&prop=wikitext&format=json&formatversion=2"
python3 -I scripts/build_senate.py
python3 -I scripts/update_results.py --offline
