# Project guidance

This repository contains a DSH Cordis profile bundle for THU MadModel tokens. Read [README.md](README.md), [README.zh-CN.md](README.zh-CN.md) and [known limitations](docs/KNOWN_LIMITATIONS.md) before changing behavior. Preserve existing work and keep installation, permissions and limitations consistent across both languages.

## Checks and packaging

Use Node.js 22 or later. From the repository root:

```bash
npm run check
npm test
```

`check` validates JavaScript syntax and bundle/host contracts; `test` runs the fixture-based Node test suite. Run relevant checks for code changes. A documentation-only change normally needs link, content-preservation and package-list checks rather than account tests. Neither static checks nor mocked regressions establish successful live login or automatic renewal.

For an explicitly authorized local inspection package, with an existing output directory outside the repository:

```bash
npm pack --ignore-scripts --pack-destination "{{OUTPUT_DIRECTORY}}"
```

This skips lifecycle scripts, including `prepack`; report that omission. Normal `npm pack` runs the declared `prepack` checks and tests. An inspection package is not a publishable release by itself. Preserve existing artifacts and do not change versions merely to inspect a package.

## Data and behavior protection

- Use synthetic fixtures and isolated profiles for tests. Real account login, shared-profile changes, credential reads/writes and remote account operations require their specific authorization; do not infer it from permission to edit documentation or run unit tests.
- Treat tokens, authentication URLs, cookies, browser profiles and state as credentials. Do not commit them, print raw values, attach them to issues or include them in packages. Preserve the distinction between DSH credentials and local state; do not hand-parse folded YAML credentials.
- Protect `MADMODEL_API_KEY`, existing providers and user settings. Keep provider writes scoped to the matching THU provider; changes to model lists or other providers are separate product work. Preserve failure/partial status semantics and never treat an unchanged expiry as fresh renewal.
- Preserve browser ownership checks before page/session access or cleanup. Do not connect to or terminate unrelated browsers; process names alone do not establish ownership. Auto must not open interactive login windows. Saved sessions do not guarantee future server acceptance.

## Candidate and privacy gate

Inspect the actual candidate archive, not just a dry-run list. Record its version, intended channel, file list, byte size and SHA256, and bind review to the exact source and bytes. Keep `package.json`'s `files` allowlist narrow; this guidance is source-only and is not an additional package entry.

Exclude session/profile data, probes, logs, private evidence and orchestration/migration materials. Review all applicable public surfaces: source, documentation, package contents, relevant history, release assets and any images, source maps or nested archives. Distinguish confirmed sensitive data from generic system paths and synthetic examples. Preserve required copyright notices and [LICENSE](LICENSE).

Record PASS, FAIL, unverified or not applicable per scope, including missing identity-dictionary coverage and inaccessible history. Keep raw sensitive evidence outside the repository. Static or partial scans cannot clear live behavior or unexamined public history; unresolved sensitive findings or critical coverage gaps block release clearance.

## Release and rollback

Prepare synchronized documentation, [CHANGELOG.md](CHANGELOG.md), checks and a rollback plan for the exact candidate. Have the designated reviewer independently verify applicable risks before release. Review approval does not itself authorize publication: commits, pushes, tags, package publication, deployment, history rewriting and credential rotation each follow their actual authorization.

Before a specifically authorized release, identify the previous usable artifact and its hash, state/schema compatibility, responsible operator and rollback triggers. Do not promise rollback of server-side sessions or credentials by replacing a package. Verify the real published channel against the approved candidate; on failure stop subsequent channels and perform only the authorized recovery. Never describe local candidate completion as published or live-account acceptance.
