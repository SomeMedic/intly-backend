# Rabota.ru fixtures

These fixtures are minimized anonymous public Rabota.ru SSR samples captured on 2026-10-04.

- `region-contract-request.json` and `region-contract-sample-response.json` cover the public `/api-web/v5/regions/suggest.json` city catalog contract used by `/regions/`.
- `live-list-first3.html` keeps only the first three public JobPosting JSON-LD entries from the observed vacancy listing.
- `live-detail-*.html` keeps only the public Nuxt vacancy literal needed by the parser for the same IDs.
- `live-empty-region-rovno.html` is a minimized anonymous public empty listing observed at `https://rovno.rabota.ru/vacancy/?sort=date` on 2026-10-04; it keeps the Nuxt `rabota.search` zero-count state (`totalVacancies`, `relevantVacancies`, `actualVacancies`, empty `vacancies`/`queryGroups`, `sort.field=date`, `sort.direction=desc`, `location.region_id=1855`).

The files intentionally avoid `.local` dependencies and do not require executing remote JavaScript.
