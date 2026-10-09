# WWR catalog fixture provenance

`native-*.html` fixtures are sanitized native DOM captures produced from ordinary browser rendering of public We Work Remotely pages and copied from `.local/reports/public-source-wwr-html-20261005/` on 2026-10-05 after body chunk verification. Sanitization removed non-LD scripts and CSRF/token metadata; no credentials or account data are present.

Synthetic fixture files in this directory are hand-written minimal public HTML shapes used to exercise category discovery, overlap dedupe, pagination, fixed-window filtering, detail extraction, RSS fallback, and incomplete-catalog reporting.

`*.rss.xml` fixtures are official public We Work Remotely category RSS responses captured live on 2026-10-05 and copied from `.local/reports/public-source-wwr-html-20261005/`. They are used only for finite category-feed fallback coverage when the primary HTML catalog homepage is access-blocked before traversal starts.
