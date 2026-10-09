# Workspace native fixtures

- `list.html` is copied from `.local/reports/public-html-live-20261004/workspace.html`.
- `page2-xhr.json` is copied from `.local/reports/public-html-live-20261004/workspace-page2-xhr.body`.
- `detail-18993.html` is a hand-retained minimal DOM fixture for public tender 18993, reconstructed from retained local extracted records and the compiled live probe. No tender document attachment was observed for this record in the retained evidence, so this fixture intentionally contains no attachment links.

Synthetic attachment and site-policy link cases are generated inside `test/workspace-collection.test.mjs`; they are regression fixtures for parser behavior, not observed native attachments.
