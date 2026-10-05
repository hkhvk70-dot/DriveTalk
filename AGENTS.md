# Contributor and assistant rules

- Work only on the public source tree. Do not recover private configuration from another directory or deployment.
- Keep demonstration data synthetic. Never commit credentials, vehicle identifiers, account/device inventories, location histories, login QR data, logs or signed packages.
- Keep API requests authenticated, same-origin and TLS validated. Never disable those checks to make a test pass.
- Do not invoke paid models, wake a vehicle or perform real home/vehicle actions without specific human authorization for that operation.
- Device writes must remain explicit, schema-validated and rate-limited. Do not automatically retry non-idempotent commands; distinguish accepted, confirmed and unknown results.
- Tests must use mocks or isolated loopback fixtures, not live accounts.
- New assets need a documented source and redistribution permission. No proprietary application extracts or vendor logos.
- Preserve the project's GPL license and all third-party attributions. Never relicense third-party code as original project code.
- Run `python scripts/check_publication.py`, backend unit tests, frontend tests and the TypeScript/build checks before preparing a source bundle.
- Publishing requires the owner's authorization. Do not reuse private repository history or personal authorship configuration.
