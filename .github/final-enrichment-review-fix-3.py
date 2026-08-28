from pathlib import Path

def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f"{path}: expected one match, got {count}")
    p.write_text(text.replace(old, new, 1), encoding="utf-8")

replace_once(
    "README.md",
    """# Enrich a completed discovery run (clustering, query-language suggestions, or both)
npm run enrich -- --run <source-run-id> --modules clusters
npm run enrich -- --run <source-run-id> --modules query_suggestions
npm run enrich -- --run <source-run-id> --modules query_suggestions --sources google_autocomplete,google_related_search,google_paa --max-suggestions-per-source 20
npm run enrich -- --resume <enrichment-id>
""",
    """# Enrich a completed discovery run. Deep modules use a 5-200 keyword shortlist.
npm run enrich -- --run <source-run-id> --modules clusters
npm run enrich -- --run <source-run-id> --modules query_suggestions --shortlist-file input/shortlist.txt
npm run enrich -- --run <source-run-id> --modules query_suggestions --shortlist-file input/shortlist.txt --sources google_autocomplete,google_related_search,google_paa --max-suggestions-per-source 20
npm run enrich -- --resume <enrichment-id>
""",
)

replace_once(
    "src/cli/enrich.ts",
    """  console.log('  --shortlist <a,b,...>       Inline shortlist of 5-200 keywords.');
  console.log('  --shortlist-file <path>     TXT (one per line) or CSV with a keyword column.');
  console.log('  --sources <a,b,...>         Query-suggestion sources.');
""",
    """  console.log('  --shortlist <a,b,...>       Inline shortlist of 5-200 keywords.');
  console.log('  --shortlist-file <path>     TXT (one per line) or CSV with a keyword column.');
  console.log('                              Required by query_suggestions, domain_age, pages, site_structure.');
  console.log('  --sources <a,b,...>         Query-suggestion sources.');
""",
)
