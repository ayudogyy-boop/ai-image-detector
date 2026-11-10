# Offline C2PA components

- SDK: `@contentauth/c2pa-web` **0.16.0**, installed from the npm registry with package-lock integrity checks. Source: <https://github.com/contentauth/c2pa-js>.
- WASM: `@contentauth/c2pa-wasm` **0.14.0**, as required by that SDK. `c2pa_bg.wasm` and the prebuilt `c2pa_worker.js` are copied unchanged from the published web package.
- `index.mjs` is bundled from the SDK and dependencies by `build/vendor-c2pa.mjs`; it exports only createC2pa, Reader and Context.
- Compatibility patch: the SDK's HTTPS-only worker URL guard additionally permits same-origin `chrome-extension:` URLs and same-origin localhost HTTP for tests. It does not permit arbitrary HTTP hosts. The build asserts the exact upstream guard before replacement. We use an explicitly packaged worker, with no blob worker or relaxed CSP.
- Initialization patch: worker startup is limited to 12 seconds and the worker is terminated on failure. The build asserts the exact upstream initialization before replacement. The application also bounds complete verification and cleanup to 15 seconds, disposes a stalled runtime and recreates it for later requests.
- Licenses: `THIRD-PARTY-LICENSES.txt` includes the SDK MIT texts and dependency ISC notices. The SDK test fixture is separately attributed in `test-c2pa/sdk-c-source.json`.
- Trust list source: <https://github.com/c2pa-org/conformance-public/tree/main/trust-list>. Both PEM files are unmodified snapshots downloaded on 2026-11-10, with SHA-256 and source URLs in `trust-snapshot.json`. Attribution: C2PA Conformance Program, **CC BY 4.0**; full text in `TRUST-LIST-LICENSE.txt`.
- The official signing and TSA anchor snapshots are supplied to the SDK's trust configuration. Runtime remote manifest fetching and OCSP requests are disabled. Trust is relative to this bundled snapshot, not a live revocation or conformance certification service.

Rebuild locally: `npm run vendor:c2pa`. Explicitly refresh public trust lists: `node build/vendor-c2pa.mjs --update-trust`; review the changed PEM files and snapshot before release. A normal build never refreshes trust or downloads runtime code.
