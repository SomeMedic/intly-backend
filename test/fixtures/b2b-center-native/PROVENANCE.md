# B2B-Center native public fixtures, 2026-10-06

Anonymous public evidence captured for `B2bCenterConnector` without login, submissions, private APIs, or browser credential state.

Source URLs:

- `https://www.b2b-center.ru/site/api/v1/market-search/?date_start_dmy=06.09.2026&date_end_dmy=06.10.2026&macro_trade_type=buy&tab=all&sort=date_desc&page=1&page_size=20&is_seo=0` -> `api-search-buy-all-page-1.json`
- `https://www.b2b-center.ru/site/api/v1/market-search/?date_start_dmy=06.09.2026&date_end_dmy=06.10.2026&macro_trade_type=buy&tab=all&sort=date_desc&page=2&page_size=20&is_seo=0` -> `api-search-buy-all-page-2.json`
- `https://www.b2b-center.ru/site/api/v1/market-search/?date_start_dmy=06.09.2026&date_end_dmy=06.10.2026&macro_trade_type=sell&tab=all&sort=date_desc&page=1&page_size=20&is_seo=0` -> `api-search-sell-all-page-1.json`
- `https://www.b2b-center.ru/app/market-next/postavka-bumazhnykh-paketov-dlia-khleba-ts-perekrestok/tender-4630191/` -> `detail-4630191.html`

Observed limits:

- `buy/all` page 1 and page 2 returned the same 20 `trade_id` values, so anonymous native pagination is treated as incomplete until a non-repeating next-page protocol is verified.
- `buy_simple/all` returned only `{"redirect_link":"/app/next/market-search/"}` and is not used as a concrete anonymous list schema.
- `buy/all` page 1 exposed 20 fresh procurement records; `sell/all` page 1 exposed 20 fresh selling records.
