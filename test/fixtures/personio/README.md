# Public Personio feed fixtures

Captured on 2026-10-04 from public company career feeds, without an account or application submission:

- `codecentric-native-live.xml`: https://codecentric.jobs.personio.com/xml — 17 positions, all with native German description sections.
- `codecentric-live.xml`: https://codecentric.jobs.personio.com/xml?language=en — the same 17 positions, with empty untranslated descriptions. Kept to document why the collector reads the native feed.
- `open-native-live.xml`: https://open.jobs.personio.com/xml — 6 positions, including 2 with native `createdAt` within the observed 30-day window.
- `open-live.xml`: https://open.jobs.personio.com/xml?language=en — 6 positions with full English descriptions.

The observed root is `workzag-jobs`. Feeds contain position ids, sectioned HTML descriptions, employer/subcompany where supplied, primary and additional offices, seniority, schedule, keywords, and `createdAt`. That timestamp is retained with `sourceDateField: createdAt`; it is not proof that the platform exposes every original publication/republication time. Unavailable description and date fields stay absent. The canonical individual career URL is `/job/<id>`.

Reference: https://developer.personio.de/v1.0/reference/get_xml and https://support.personio.de/hc/en-us/articles/207576365-Integrate-jobs-from-Personio-into-your-website-via-XML.

These are public input fixtures for regression checks, not evidence that all Personio employers or the full INTLY project are accepted.
