# thu-tok-auto

English | [简体中文](README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/thu-tok-auto?style=flat)](https://www.npmjs.com/package/thu-tok-auto) [![Node.js >=22](https://img.shields.io/badge/Node.js-%3E%3D22-339933?style=flat)](#requirements) [![License: MIT](https://img.shields.io/badge/License-MIT-blue?style=flat)](LICENSE)

A Cordis profile bundle for DSH / DeepSeek Harness that obtains THU MadModel API tokens, writes them to DSH credentials and synchronizes the matching model provider.

[Changelog](CHANGELOG.md) · [Known limitations (中文)](docs/KNOWN_LIMITATIONS.md) · [npm](https://www.npmjs.com/package/thu-tok-auto)

## Status and support

Maintenance scope: fixes and compatibility maintenance. Published versions are listed on [npm](https://www.npmjs.com/package/thu-tok-auto); changes are recorded in the [changelog](CHANGELOG.md).

The host contracts were historically checked against DSH `0.2.0-rc.2`. Browser discovery and process cleanup primarily target Windows with Edge or Chrome; other platforms have not completed real-device acceptance. **Automatic renewal against the live THU service remains unverified**: mocked regressions do not establish that the server will accept a restored session or a hidden browser's fingerprint. This documentation update does not certify a new live test.

## Requirements

- Node.js **22 or later**; the plugin uses built-in `fetch` and `WebSocket`.
- A DSH profile with the settings, credentials, timer, web server, connection and `llm-pi-ai` services.
- Edge or Chrome on the host for interactive login and browser-assisted renewal.
- An authorized MadModel account and network access to MadModel and THU identity services. Off-campus WebVPN is not supported by this version.

## Installation

Install the published profile bundle:

```bash
dsh plugin --profile web add thu-tok-auto
```

Restart the corresponding DSH host/profile. A page refresh alone does not reload host code. The installation signal is the **Get / Auto / elapsed-time** row above Settings in the sidebar (above other buttons in that group, when present). Its appearance confirms UI loading, not successful authentication.

The command is the existing documented DSH installation interface; this documentation-only update did not run it against a shared profile. Substitute your intended profile for `web` when appropriate.

## Quick start

1. Click **Get**. The plugin tries existing-credential issuance, saved SSO replay and reuse of an existing token. If a manual request cannot obtain a fresh token, it opens its own login window. Complete THU login there; the same request should capture, validate, store and synchronize the token without a second click, then close that window.
2. Inspect the status text and hover details. A healthy result requires server validation, a usable stored credential and successful provider synchronization. `partial` means one of these steps did not complete. Receiving the same expiry is reported as renewal not taking effect, not as a fresh token.
3. Enable **Auto** for host-side renewal attempts every 20 minutes. It does not require the DSH page or login window to remain open. **The DSH host must remain running.** Auto never opens an interactive login window; when saved sessions stop working, click Get and log in again.

The timer measures local time since the last recorded Get, **not time until token expiry**. It displays `--:--` without a baseline and caps the hour field at 99. Hover details separate the last manual request from the last automatic run.

To assess live Auto behavior, expiry must advance on a natural automatic run after login. No account login or live renewal was performed for this documentation candidate; do not infer that acceptance from the UI or unit tests.

## Configuration, data and permissions

No token needs to be pasted into public configuration. The plugin stores the token through DSH's credential service as `MADMODEL_API_KEY`, and uses `settings.describe()` / `settings.update()` to merge the matching provider's `apiKeyEnv` and `models`.

It identifies a provider by the credential reference or MadModel base URL, including the supported local-forwarding case. Otherwise it creates `llm-pi-ai.providers.madmodel` with `api: openai-completions`. A conflicting unrelated `madmodel` key is reported rather than overwritten. Other providers are preserved; **manual model entries inside the selected provider can be replaced by the next synchronization**. This plugin's current model synchronization targets THU MadModel; it does not manage Paratera providers.

| Data or permission | Purpose and retention |
| --- | --- |
| DSH credential `MADMODEL_API_KEY` | Stores the API token. Storage protection is provided by DSH; this plugin does not claim a separate encrypted vault. |
| `%USERPROFILE%\.dsh\madmodel\state.json` | Stores cookies/SSO session material, Auto preference, timestamps and diagnostics. New state omits the token; legacy tokens are migrated to DSH credentials. Treat the entire file as a credential. |
| `%USERPROFILE%\.dsh\madmodel\profile\` and temporary carrier profiles | Browser login/session data. Owned temporary carrier profiles may be cleaned up; persistent state and the shared login profile are not a logout mechanism. |
| Browser launch, loopback DevTools ports 9333–9343 and process inspection | Capture login and restore saved sessions only after checking browser ownership. Windows fallback termination requires matching recorded process identity; it does not kill browsers by name. |
| DSH settings and credential writes | Configure the selected provider and replace its token after validation. Removing the plugin does not automatically undo these writes. |

The state writer requests file mode `0600` on a best-effort basis; that is **not a guarantee of Windows ACL isolation or encryption**. Protect the host user account, backups and directory access. Never attach the state file, browser profile, credential store, authentication URLs or raw diagnostics to a public issue.

The plugin makes authentication/model-list requests to MadModel and THU identity services and uses local DevTools connections. Cookies are selected by destination domain, path, secure flag and expiry; restored browser cookies are subject to ownership and host checks. There is no telemetry submission in the plugin's current implementation. This statement does not cover the host, browser or remote service's own data handling.

### Renewal and model-list behavior

The saved SSO session, rather than an indefinitely open browser, enables later attempts. Server expiry, revocation, device checks and network access can prevent renewal. Historical observations found anonymous issuance rejected on 2026-09-29 and replay sessions shorter-lived than the token; these are dated observations, not a service contract.

Auto retries use 5/10/20/30-minute backoff. With less than one hour of token lifetime remaining, retry delay returns to five minutes; this cannot guarantee renewal before expiry. A reused token is not a fresh issuance. A network failure leaves validation unknown rather than proving the token invalid; a rejected or unvalidated candidate must not replace a credential still known to work.

The model list is read from the site's frontend bundle, cached for six hours, and falls back to a built-in list if parsing fails. `DeepSeek-V4-Flash-Vision-Exp` and `DeepSeek-R1-W8A8` are excluded. The configured context window is 1,000,000 tokens, based on historical measurements, not a newly verified capacity promise. See the [Chinese technical detail](README.zh-CN.md#模型列表跟着站点走) for the original measurements and exclusions.

## Upgrade and uninstall

```bash
dsh plugin --profile web up thu-tok-auto
```

Restart the host/profile after upgrading. Version 0.2.1 and later use a profile bundle; older dynamic-plugin installations require checking the host's installation state. Existing local state is reused, and legacy token migration does not revoke a server-side token.

To uninstall, remove `thu-tok-auto` from the intended profile's bundle declaration (`dsh.profile.bundles`) and dependency declaration in its `package.json`, reconcile that profile's dependencies through its supported package-management workflow, then restart the host. No host-specific CLI removal command is claimed here because it has not been verified. Avoid editing a different active profile.

Unloading attempts to close only an identifiable plugin-owned browser. **It does not automatically delete persistent state/profile data, remove `MADMODEL_API_KEY`, remove the synchronized provider or revoke THU sessions/tokens.** For complete removal, after the relevant host/profile has stopped using them, separately remove the plugin's data directory and use DSH's supported credential/settings controls to remove entries no other component needs. Revoke sessions/tokens through the issuing service where required. No cleanup or revocation was executed for this candidate.

## Limitations and troubleshooting

- **No control row:** confirm installation in the intended profile and restart the host. The row depends on DSH's sidebar DOM and may fail to mount after host changes; a frontend refresh cannot update host code.
- **Needs login / expired:** saved server sessions may have expired. Click Get and complete login once; Auto will not display a login window on its own.
- **Renewal did not take effect:** the returned expiry did not advance. A green Auto switch means scheduling is enabled, not that renewal succeeded.
- **Network unreachable / validation unknown:** check connectivity first; these messages alone do not establish that the token was revoked.
- **Token updated, provider not synchronized:** treat the operation as partial and inspect the configuration error without posting secrets.
- **Browser ownership cannot be verified:** cleanup refuses uncertain ownership. Do not stop unrelated browsers. `node lib/stop-owned.js --dry-run` inspects the plugin's local ownership record; `node lib/stop-owned.js` attempts verified cleanup. These are operational commands, not privacy-safe report generators.
- **Timer differs from service behavior:** the panel decodes JWT `exp` against the local clock; keep system time synchronized. Historical six-hour token life and approximately 45-minute reusable SSO sessions are observations, not guaranteed limits.
- Do not manually join lines from DSH's YAML credential file: quoted YAML continuation escapes are not part of the token. Use DSH's credential service or a YAML parser when appropriate.

See [known limitations](docs/KNOWN_LIMITATIONS.md) for unverified live renewal, Windows-centric browser support, WebVPN and cleanup limits. The original Chinese README preserves additional technical history.

## Development

From a source checkout:

```bash
npm run check
npm test
```

The package uses Node built-ins and host-provided services; `package.json` declares no runtime dependencies. `npm run check` checks syntax and host/bundle contracts. Tests use dependency-injected environments and fixtures. The 213 fixture regressions and bundle checks are used for release preparation. Live THU login and natural Auto renewal still require separate acceptance against the service. `prepack` normally runs both commands.

`lib/core.js` contains lifecycle and synchronization logic; `lib/index.js` wires host services, routes and browser adapters; `lib/ui.js` renders the control. `test/preview/` is an isolated fake-state preview and is excluded from the npm package. Source-only reports and private migration/orchestration material must not be added to the package.

- [Changelog](CHANGELOG.md)
- [Known limitations (中文)](docs/KNOWN_LIMITATIONS.md)
- [Original technical detail and historical measurements (中文)](README.zh-CN.md)

## Feedback and security

Report reproducible, sanitized problems through [GitHub Issues](https://github.com/OverDustD7/thu-tok-auto/issues). Include host/plugin versions, the failing step and redacted status text. No private security-reporting channel is verified in this documentation; do not post credentials, cookies, authentication URLs or personal information publicly.

## License and third-party notices

[MIT](LICENSE); the existing copyright notice is preserved. DSH, Node.js, Edge/Chrome and THU services are separate third-party products/services governed by their own terms and licenses. They are not redistributed by this package; this plugin does not grant access to THU services or imply their endorsement.
