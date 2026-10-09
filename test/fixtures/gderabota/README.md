# GdeRabota fixtures

These fixtures are public Inertia SSR payloads captured on 2026-10-04 from anonymous GET requests to gderabota.ru. Most older fixtures are minimized to the fields required by connector tests; live-page/live-detail evidence fixtures preserve the observed provider payload.

- `search.html`: `VacancyList/index` with the first live listing item and pagination metadata needed by connector tests.
- `detail.html`: `Vacancy/index` for vacancy `159668`, trimmed to `props.vacancy` and `props.employerCompanyData`.
- `moderation-234667.html`: observed `vacancyFirstModeration/index` detail page for vacancy `234667`, deliberately without `props.vacancy`.
- `detail-233426-404.html`: observed `Errors/index` HTTP 404 response for stale listed vacancy `233426`, trimmed to error metadata.
- `page89-missing-url-231461.html`: observed `VacancyList/index` item for vacancy `231461` with empty `viewUrl`/`externalUrl`, trimmed to the listed item.
- `live-page-631.html` / `live-detail-2172937.html`: observed anonymous HTTP 200 fixtures for GdeRabota provider route `/вакансии/vacancy-info/1220200004397/8a73f358-be4d-11f1-a6ab-f7c7dbb1567d`, where listing id `2172937` is verified from detail `Vacancy/index` payload instead of the URL path.
