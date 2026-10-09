# Budu public search contract

`budu-list.html` is the saved public vacancies HTML, with the bootstrap CSRF token replaced by synthetic test data. It contains the site's original cached Transit application state.

`search-page-2.transit.json` is an independently transcribed, uncompressed wire golden. The return EQL comes from the site's saved client bundle: `AAa` (search mutation), `K_b` (SearchResult), `L_b` (SearchResultsQuery), `lSb` / `W6a` (VacancyCard), `kSb` (specialization/skill tags), and `E1` (City). Component metadata names are not EQL entries.

The EQL mutation join is a map whose key is a mutation list. Transit encodes that composite key using `~#cmap` and `~#list`, as defined by the [Transit format](https://github.com/cognitect/transit-format) and the [Cognitect writer](https://github.com/cognitect/transit-js/blob/master/src/com/cognitect/transit/impl/writer.js).

API test responses are synthetic data under the mutation symbol, separate from normalized bootstrap UI state. They prove the documented protocol and collector behavior; they do not prove current network access, live API acceptance or the entire platform's 30-day history.
