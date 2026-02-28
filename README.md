# VS Code Copilot Subscription Spend

VS Code extension that shows current monthly GitHub billing usage for Copilot premium requests in the status bar.

Example status text:

`Copilot: $99.70`

## What it does

- Uses your existing VS Code GitHub account session when available.
- Uses global VS Code proxy settings (`http.proxy`, `http.proxySupport`, `http.proxyStrictSSL`) for GitHub API requests.
- Reads spend and budgets from official GitHub Billing REST API endpoints.
- Matches budget by SKU text filter (default: `premium request`).
- Auto-refreshes on a configurable interval.
- Supports optional fallback token in VS Code Secret Storage.
- Shows guided actions on status bar click (connect, token, diagnose, refresh).
- Supports manual fallback values for personal accounts when billing API is unavailable.

## Setup

1. Run command: **Copilot Spent: Connect GitHub Account**.
2. (Optional) Set `copilotSpentStatus.org` if you want organization billing.
3. (Optional) Tune `copilotSpentStatus.skuFilter` if your budget label differs.
4. If GitHub session is unavailable, use **Copilot Spent: Set GitHub Token** as fallback.
5. Status bar item appears automatically and refreshes every 5 minutes.

Auth source priority in extension:

1. Token from Secret Storage (`Copilot Spent: Set GitHub Token`)
2. `copilotSpentStatus.githubToken` setting
3. `GITHUB_TOKEN` environment variable
4. VS Code GitHub account session (`Copilot Spent: Connect GitHub Account`)

## Required GitHub permissions

- For organization budgets: token needs organization administration read access for billing endpoints.
- For personal billing: access to your own billing endpoints.

## Commands

- `Copilot Spent: Connect GitHub Account`
- `Copilot Spent: Refresh`
- `Copilot Spent: Set GitHub Token`
- `Copilot Spent: Set Manual Values From Budget Text`
- `Copilot Spent: Open Budgets Page`
- `Copilot Spent: Open Help Actions`
- `Copilot Spent: Diagnose Billing API Access`

## Settings

- `copilotSpentStatus.org`: organization slug (empty = personal account)
- `copilotSpentStatus.skuFilter`: text used to identify budget/SKU objects
- `copilotSpentStatus.refreshMinutes`: refresh interval in minutes
- `copilotSpentStatus.githubToken`: optional plaintext fallback token
- `copilotSpentStatus.manualSpent`: manual fallback spent value (USD)
- `copilotSpentStatus.manualBudget`: manual fallback budget value (USD)

## Use in normal VS Code UI (without F5)

### Fast path (recommended)

Run one command in project root:

```bash
make quick-install
```

Then reload VS Code window once.

### Update after local code changes

```bash
make quick-update
```

Then run **Developer: Reload Window**.

To verify the installed build and version:

```bash
make status
```

This rebuilds/reinstalls the extension into your regular VS Code UI (no F5 debug host required) and prints current package/install info.

## Build with Makefile

- `make MakeBuild` or `make build` — compile extension
- `make status` — show package version, VSIX name, and installed extension versions
- `make marketplace-check` — validate Marketplace-required metadata/files/icon
- `make lint` — run eslint
- `make test` — run tests
- `make package` — build `.vsix`
- `make install-vsix` — build and install locally into current VS Code
- `make quick-install` — one-command install (installs deps + builds + installs)
- `make quick-update` — one-command local update after code changes
- `make bump-patch|bump-minor|bump-major` — bump version in `package.json`
- `make release-local` — bump patch + reinstall locally
- `make node-check` — print Node.js compatibility hint

Local package output path:

- `build/<extension-name>-<version>.vsix`

## Install from GitHub Release (.vsix)

This is the simplest installation path without Marketplace.

1. Open the repository **Releases** page on GitHub.
2. Pick the required version tag (for example, `v0.0.3`).
3. Download the attached `.vsix` asset.
4. In VS Code, run **Extensions: Install from VSIX...**.
5. Select the downloaded `.vsix` file.

After installation, update the extension by installing a newer `.vsix` from a newer GitHub Release.

## Node.js version note

- Recommended runtime for local build: **Node 22 LTS** (or 24+).
- If you use odd Node versions (for example 23.x), `npm` may print `EBADENGINE` warnings from dependencies.
- These warnings are usually non-fatal, but for the cleanest setup switch to Node 22 LTS.

## Publish to VS Code Marketplace

### 1) One-time setup

1. Create publisher in Visual Studio Marketplace (Publisher Management).
2. Add publisher ID to `package.json` field `publisher`.
3. Ensure extension `name` in `package.json` stays stable.
4. Create Marketplace PAT with **Manage** scope.

### 2) Publish release (manual)

0. Validate metadata/files first:

	```bash
	make marketplace-check
	```

1. Bump `version` in `package.json`.
2. Run publish command:

	```bash
	VSCE_PAT=<your_marketplace_pat> make publish
	```

3. After publication, users install from Marketplace once, then VS Code updates automatically when you publish newer versions.

### 3) Publish release (automated via GitHub Actions)

Workflows:

- `.github/workflows/ci-auto-version-bump.yml`
- `.github/workflows/publish-marketplace.yml`
- `.github/workflows/release-vsix.yml`

Triggers:

- every push to `master`/`main`: runs build and auto-increments `patch` version in `package.json` + `package-lock.json`
- semver tag `v*.*.*`: builds VSIX and creates a GitHub Release with `.vsix` asset
- the same semver tag also publishes to VS Code Marketplace

Required repository secret:

- `VSCE_PAT` with Marketplace **Manage** scope

CI checks:

- fails if `package.json.publisher` is missing
- publish run resolves extension version directly from git tag (`v1.2.3` → `1.2.3`) before packaging/publish

Recommended release flow (GitHub Releases + Marketplace):

```bash
git push
# wait for CI auto-bump commit on master/main
git pull
VERSION=$(node -p "require('./package.json').version")
git tag "v${VERSION}"
git push origin "v${VERSION}"
```

Result after tag push:

- GitHub Release is created automatically
- compiled `.vsix` is attached to the release assets
- Marketplace publish workflow runs for the same tag (if `VSCE_PAT` secret is configured)

### 4) Install from Marketplace (user side)

1. Open Extensions view.
2. Search by publisher/name.
3. Click **Install**.

Once installed from Marketplace, users can update from Extensions UI (or via auto-update).

Marketplace updates require a new published version. Local `quick-update` affects only your machine.

## API notes

The extension uses GitHub REST billing endpoints and automatically tries fallback paths to avoid 404 issues:

- `/orgs/{org}/settings/billing/usage`
- `/orgs/{org}/settings/billing/budgets`
- `/organizations/{org}/settings/billing/usage`
- `/organizations/{org}/settings/billing/budgets`
- `/user/settings/billing/usage`
- `/user/settings/billing/budgets`
- `/users/{login}/settings/billing/usage`
- `/users/{login}/settings/billing/budgets`

All requests include `X-GitHub-Api-Version: 2022-11-28`.

## Troubleshooting 404

- Run `Copilot Spent: Connect GitHub Account` and refresh.
- If using organization mode, verify `copilotSpentStatus.org` is correct.
- If response is still 404, keep `org` empty to test personal scope first.
- Important: user-level billing endpoints return data only when Copilot is billed directly to your personal account. If your Copilot license is billed via organization/enterprise, user endpoints may return 404 and you should use org mode.
- For personal accounts with persistent 404, use **Copilot Spent: Set Manual Values From Budget Text** and paste line from budgets page (e.g. `$95.86 spent $150.00 budget`).

## Troubleshooting 403

- `403` for **user account** usually means GitHub user billing endpoints are not available for your current plan/auth type.
- Practical workaround: use organization mode (`copilotSpentStatus.org`) where you are owner/billing manager.
- If using token auth, set PAT via **Copilot Spent: Set GitHub Token** and ensure billing-related access for your target scope.
- Run **Copilot Spent: Diagnose Billing API Access** to see exact HTTP status for each billing endpoint in the Output panel.
