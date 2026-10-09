# Roseltorg native public fixtures

These are retained anonymous HTTP GET responses from the official Roseltorg public site on 2026-10-05. They contain public procurement material, including native customer/contact facts. The diagnostic request manifest, headers, hashes and public JavaScript contract evidence are in `.local/reports/roseltorg-native-discovery-20261005.json` and its companion fixture directory.

| Fixture | Official request |
| --- | --- |
| `catalog.html` | `https://www.roseltorg.ru/procedures/search` |
| `list-page-0.html`, `list-page-1.html` | `https://www.roseltorg.ru/procedures/search_ajax?sale=1&currency=all&start_date_published=05.09.26&end_date_published=05.10.26&status%5B%5D=5&status%5B%5D=0&status%5B%5D=1&status%5B%5D=2&status%5B%5D=3&status%5B%5D=4&page={0,1}` |
| `detail-{procedure}-1.html` | `https://www.roseltorg.ru/procedure/{procedure}/1` for the five procedure numbers in the filenames |
| `control-no-xhr.html` | Same all-status AJAX request with both dates `05.09.26`, page `0`, and no `X-Requested-With` header |
| `empty-native.html` | Same all-status AJAX request with both dates `06.10.26`, page `0`, and no `X-Requested-With` header |

The catalog uses two-digit wire years, zero-based pages and native `data-href` next controls. The AJAX response is HTML. A four-digit year silently fails to narrow publication dates. The full catalog has no observed reliable total count, so these two list pages do not establish complete 30-day coverage.

The September business detail visibly says `НМЦ не указано` while JSON-LD reports `0.00`; the budget must stay unknown. The Rostelecom RFI visibly advertises zero, so its zero and qualifier are retained. Dates in detail pages carry `+03:00` or `МСК`. File labels and direct native URLs are preserved as metadata without downloading documents or inferring eligibility.

Tests use the retained list and five actual detail pages for the native contract. They also construct clearly synthetic pages in the test source for window boundaries, lot identity, long pagination, repetition, cancellation and hostile URLs. Unsampled details on the retained 20-card pagination test use synthetic native detail markup; that test proves parsing/traversal rather than live completeness.

The three `refresh-hydro-*.html` fixtures are explicitly synthetic mutations of `detail-32616434303-1.html`: `changed` changes status, deadline, total lot price and tax; `omitted` removes selected native fields and changes status to suspended; `older` changes publication to January 2025. They prove selective refresh behavior and are not additional live observations. Refresh keeps the fresh source HTML separately from `effectiveHtml`, whose omitted fields are copied from retained native evidence. Fresh identity, canonical URL and title remain mandatory before any fallback.
