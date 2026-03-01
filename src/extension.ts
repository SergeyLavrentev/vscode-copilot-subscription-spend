import * as vscode from 'vscode';
import * as https from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';

const SECRET_KEY = 'githubToken';
const API_VERSION = '2022-11-28';
const AUTH_PROVIDER_ID = 'github';
const USER_AGENT = 'copilot-spent-status-vscode-extension';
let proxyAgentCache: { key: string; agent: unknown } | undefined;

type FetchResult = {
	spent: number;
	budget?: number;
	matchedBudgetLabel?: string;
	source: 'org' | 'user';
	breakdown: Array<{ product: string; amount: number }>;
};

type HelpAction =
	| 'connect'
	| 'token'
	| 'manual'
	| 'refresh'
	| 'diagnose'
	| 'openBudgets'
	| 'openOrgSettings';

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Copilot Spent Status');
	const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 200);
	statusItem.command = 'copilot-spent-status.openHelp';
	statusItem.text = 'Copilot: $(sync~spin) loading...';
	statusItem.tooltip = 'GitHub Copilot billing usage';
	statusItem.show();

	let refreshTimer: NodeJS.Timeout | undefined;

	const connectGitHubCommand = vscode.commands.registerCommand('copilot-spent-status.connectGitHub', async () => {
		try {
			await getGitHubSession(getConfig().org, true);
			vscode.window.showInformationMessage('GitHub session connected for Copilot Spent Status.');
			await refresh(true);
		} catch (error) {
			void vscode.window.showErrorMessage(`Copilot Spent Status: ${getErrorMessage(error)}`);
		}
	});

	const setTokenCommand = vscode.commands.registerCommand('copilot-spent-status.setToken', async () => {
		const token = await vscode.window.showInputBox({
			prompt: 'Fine-grained PAT с разрешением Account → Plan: Read-only (обязателен для personal billing)',
			password: true,
			ignoreFocusOut: true,
			placeHolder: 'github_pat_... (fine-grained PAT)'
		});

		if (token === undefined) {
			return;
		}

		const trimmedToken = token.trim();
		if (!trimmedToken) {
			await context.secrets.delete(SECRET_KEY);
			vscode.window.showInformationMessage('Токен удалён из Secret Storage.');
			await refresh();
			return;
		}

		await context.secrets.store(SECRET_KEY, trimmedToken);
		vscode.window.showInformationMessage('Fallback token сохранён в Secret Storage.');
		await refresh();
	});

	const refreshCommand = vscode.commands.registerCommand('copilot-spent-status.refresh', async () => {
		await refresh(true);
	});

	const openBudgetsCommand = vscode.commands.registerCommand('copilot-spent-status.openBudgets', async () => {
		await vscode.env.openExternal(vscode.Uri.parse('https://github.com/settings/billing/budgets'));
	});

	const setManualFromTextCommand = vscode.commands.registerCommand('copilot-spent-status.setManualFromText', async () => {
		const input = await vscode.window.showInputBox({
			prompt: 'Вставьте строку из GitHub budgets, например: "$95.86 spent $150.00 budget"',
			ignoreFocusOut: true,
			placeHolder: 'All Premium Request SKUs - $95.86 spent $150.00 budget'
		});

		if (!input) {
			return;
		}

		const parsed = parseManualBudgetText(input);
		if (!parsed) {
			void vscode.window.showErrorMessage('Не удалось распознать суммы. Ожидается текст вида "$95.86 spent $150.00 budget".');
			return;
		}

		const config = vscode.workspace.getConfiguration('copilotSpentStatus');
		await config.update('manualSpent', parsed.spent, vscode.ConfigurationTarget.Global);
		await config.update('manualBudget', parsed.budget, vscode.ConfigurationTarget.Global);

		void vscode.window.showInformationMessage(`Manual values saved: ${formatUsd(parsed.spent)} / ${formatUsd(parsed.budget)}`);
		await refresh(true);
	});

	const openHelpCommand = vscode.commands.registerCommand('copilot-spent-status.openHelp', async () => {
		await showHelpActions();
	});

	const diagnoseCommand = vscode.commands.registerCommand('copilot-spent-status.diagnoseAccess', async () => {
		output.clear();
		output.appendLine('=== Copilot Spent Status: Billing API Diagnose ===');
		output.appendLine(`Time: ${new Date().toISOString()}`);

		try {
			const auth = await resolveAuthAndConfig(context, true);
			output.appendLine(`Auth source: ${auth.authSource}`);
			output.appendLine(`Org setting: ${auth.org || '<empty>'}`);
			output.appendLine(`Proxy: ${getProxyDebugLine()}`);

			const login = await getAuthenticatedLogin(auth.token);
			if (login) {
				output.appendLine(`GitHub login: ${login}`);
			}

			const endpoints: Array<{ label: string; path: string }> = [];
			if (auth.org) {
				const orgId = encodeURIComponent(auth.org);
				endpoints.push(
					{ label: 'org premium_request usage', path: `/organizations/${orgId}/settings/billing/premium_request/usage` },
					{ label: 'org usage/summary', path: `/organizations/${orgId}/settings/billing/usage/summary` },
					{ label: 'org usage', path: `/organizations/${orgId}/settings/billing/usage` },
					{ label: 'org budgets', path: `/organizations/${orgId}/settings/billing/budgets` }
				);
			}

			if (login) {
				const encodedLogin = encodeURIComponent(login);
				endpoints.push(
					{ label: 'user premium_request usage', path: `/users/${encodedLogin}/settings/billing/premium_request/usage` }
				);
			}

			// Probe all endpoints
			for (const endpoint of endpoints) {
				const result = await probeEndpoint(auth.token, endpoint.path);
				output.appendLine(`${endpoint.label}: ${result.status} ${result.statusText} (${endpoint.path})`);
				if (result.status >= 400 && result.bodySnippet) {
					output.appendLine(`  body: ${result.bodySnippet}`);
				}
			}

			output.appendLine('');
			output.appendLine('--- Notes ---');
			output.appendLine('• Personal billing API requires a fine-grained PAT with "Plan" (read) permission.');
			output.appendLine('• OAuth tokens from VS Code GitHub login do NOT have billing API access.');
			output.appendLine('• Budget API exists only for organizations, not for personal accounts.');
			output.appendLine('=== End diagnose ===');
			output.show(true);
		} catch (error) {
			output.appendLine(`Diagnose failed: ${getErrorMessage(error)}`);
			output.show(true);
			void vscode.window.showErrorMessage(`Copilot Spent Status diagnose failed: ${getErrorMessage(error)}`);
		}
	});

	const reconfigure = () => {
		if (refreshTimer) {
			clearInterval(refreshTimer);
		}

		const refreshMinutes = getConfig().refreshMinutes;
		const refreshMs = Math.max(1, refreshMinutes) * 60 * 1000;
		refreshTimer = setInterval(() => {
			void refresh();
		}, refreshMs);
	};

	const showWelcomeIfNeeded = async () => {
		const currentVersion = context.extension.packageJSON.version as string;
		const previousVersion = context.globalState.get<string>('copilotSpentStatus.lastSeenVersion');
		if (previousVersion === currentVersion) {
			return;
		}

		await context.globalState.update('copilotSpentStatus.lastSeenVersion', currentVersion);
		const title = previousVersion
			? `Copilot Spent Status updated to ${currentVersion}`
			: 'Copilot Spent Status installed';
		const choice = await vscode.window.showInformationMessage(
			`${title}. For personal billing: set a fine-grained PAT with "Plan" read permission.`,
			'Set PAT',
			'Connect GitHub (org)',
			'Run Diagnose'
		);

		if (choice === 'Set PAT') {
			await vscode.commands.executeCommand('copilot-spent-status.setToken');
			return;
		}
		if (choice === 'Connect GitHub (org)') {
			await vscode.commands.executeCommand('copilot-spent-status.connectGitHub');
			return;
		}
		if (choice === 'Run Diagnose') {
			await vscode.commands.executeCommand('copilot-spent-status.diagnoseAccess');
		}
	};

	const configListener = vscode.workspace.onDidChangeConfiguration((event) => {
		if (event.affectsConfiguration('copilotSpentStatus')) {
			reconfigure();
			void refresh();
		}

		if (
			event.affectsConfiguration('http.proxy') ||
			event.affectsConfiguration('http.proxySupport') ||
			event.affectsConfiguration('http.proxyStrictSSL')
		) {
			proxyAgentCache = undefined;
		}
	});

	async function refresh(showErrorsToUser = false): Promise<void> {
		statusItem.text = 'Copilot: $(sync~spin) loading...';

		try {
			const { token, org, skuFilter, authSource } = await resolveAuthAndConfig(context, showErrorsToUser);
			const data = await fetchSpendAndBudget(token, org, skuFilter);
			const spentText = formatUsd(data.spent);
			const budgetText = data.budget !== undefined ? formatUsd(data.budget) : '—';
			const breakdownLines = data.breakdown
				.filter((item) => item.amount > 0)
				.map((item) => `• ${item.product}: ${formatUsd(item.amount)}`);

			statusItem.text = `Copilot: ${spentText}`;
			statusItem.tooltip = [
				`GitHub Billing (${data.source === 'org' ? 'organization' : 'user'})`,
				`Auth: ${authSource}`,
				`Spend summary: ${spentText}`,
				breakdownLines.length > 0 ? 'By product (> $0):' : undefined,
				...breakdownLines,
				`Budget: ${budgetText}`,
				data.matchedBudgetLabel ? `Budget source: ${data.matchedBudgetLabel}` : undefined,
				data.source === 'user' && data.budget === undefined
					? 'Budget API unavailable for personal accounts. Set manually via Help Actions.'
					: undefined,
				`Updated: ${new Date().toLocaleString()}`,
				'Click to open actions'
			].filter(Boolean).join('\n');
		} catch (error) {
			const message = getErrorMessage(error);
			const manualValues = getManualFallbackValues();
			if (manualValues && /404|not migrated|потрачено не найдено/i.test(message)) {
				statusItem.text = `Copilot: ${formatUsd(manualValues.spent)} (manual)`;
				statusItem.tooltip = [
					'API недоступен, показаны manual значения из настроек.',
					`Spend summary: ${formatUsd(manualValues.spent)}`,
					`Budget: ${formatUsd(manualValues.budget)}`,
					'Обновите их через: Open Help Actions → Set Manual Values from Budget Text.',
					'Click to open actions'
				].join('\n');
				return;
			}

			const guidance = getFriendlyGuidance(message, getConfig().org);
			statusItem.text = `Copilot: $(warning) ${guidance.short}`;
			statusItem.tooltip = [
				`Не удалось загрузить billing данные: ${message}`,
				guidance.nextStep,
				'Click to open actions'
			].join('\n');
			if (showErrorsToUser) {
				void vscode.window.showErrorMessage(`Copilot Spent Status: ${guidance.userMessage}`);
			}
		}
	}

	async function showHelpActions(): Promise<void> {
		const quickPick = await vscode.window.showQuickPick([
			{ label: '$(key) Set GitHub PAT (recommended)', detail: 'Fine-grained PAT with Plan read — required for personal billing', action: 'token' as HelpAction },
			{ label: '$(github) Connect GitHub Account', detail: 'OAuth login — works for org billing only, not personal', action: 'connect' as HelpAction },
			{ label: '$(edit) Set Manual Values from Budget Text', detail: 'Paste "$spent spent $budget budget"', action: 'manual' as HelpAction },
			{ label: '$(refresh) Refresh Status', detail: 'Retry billing API fetch now', action: 'refresh' as HelpAction },
			{ label: '$(pulse) Diagnose Billing API Access', detail: 'Show endpoint status report in Output', action: 'diagnose' as HelpAction },
			{ label: '$(link-external) Open Budgets Page', detail: 'Open GitHub billing budgets page', action: 'openBudgets' as HelpAction },
			{ label: '$(organization) Open Org Setting in VS Code', detail: 'Configure copilotSpentStatus.org', action: 'openOrgSettings' as HelpAction }
		], {
			placeHolder: 'Copilot Spent Status actions'
		});

		if (!quickPick) {
			return;
		}

		switch (quickPick.action) {
			case 'connect':
				await vscode.commands.executeCommand('copilot-spent-status.connectGitHub');
				return;
			case 'token':
				await vscode.commands.executeCommand('copilot-spent-status.setToken');
				return;
			case 'manual':
				await vscode.commands.executeCommand('copilot-spent-status.setManualFromText');
				return;
			case 'refresh':
				await vscode.commands.executeCommand('copilot-spent-status.refresh');
				return;
			case 'diagnose':
				await vscode.commands.executeCommand('copilot-spent-status.diagnoseAccess');
				return;
			case 'openBudgets':
				await vscode.commands.executeCommand('copilot-spent-status.openBudgets');
				return;
			case 'openOrgSettings':
				await vscode.commands.executeCommand('workbench.action.openSettings', 'copilotSpentStatus.org');
				return;
		}
	}

	context.subscriptions.push(output, statusItem, connectGitHubCommand, setTokenCommand, refreshCommand, openBudgetsCommand, setManualFromTextCommand, openHelpCommand, diagnoseCommand, configListener, {
		dispose: () => {
			if (refreshTimer) {
				clearInterval(refreshTimer);
			}
		}
	});

	reconfigure();
	void showWelcomeIfNeeded();
	void refresh();
}

function getFriendlyGuidance(errorMessage: string, org: string): { short: string; nextStep: string; userMessage: string } {
	if (/403/i.test(errorMessage)) {
		return {
			short: 'need PAT',
			nextStep: org
				? 'Проверьте права owner/billing manager для org и токен.'
				: 'Нужен fine-grained PAT с разрешением "Plan" (read). OAuth-токен VS Code не работает с billing API.',
			userMessage: org
				? 'Доступ к billing API ограничен. Проверьте права для org и тип токена.'
				: 'Billing API требует fine-grained PAT с "Plan" read. Задайте токен через "Set GitHub Token".'
		};
	}

	if (/404/i.test(errorMessage)) {
		return {
			short: 'not migrated?',
			nextStep: org
				? 'Проверьте правильность org и запустите Diagnose.'
				: 'Ваш аккаунт может быть не на Enhanced Billing Platform. Используйте ручной ввод или org-режим.',
			userMessage: 'Billing endpoint недоступен (404). Аккаунт может быть ещё не мигрирован на Enhanced Billing Platform.'
		};
	}

	return {
		short: 'unavailable',
		nextStep: 'Нажмите статус-бар и выберите Diagnose Billing API Access.',
		userMessage: `Не удалось обновить данные: ${errorMessage}`
	};
}

export function deactivate() {}

function getConfig() {
	const config = vscode.workspace.getConfiguration('copilotSpentStatus');
	return {
		org: config.get<string>('org', '').trim(),
		skuFilter: config.get<string>('skuFilter', 'premium request').trim().toLowerCase(),
		refreshMinutes: config.get<number>('refreshMinutes', 5),
		manualSpent: config.get<number>('manualSpent'),
		manualBudget: config.get<number>('manualBudget')
	};
}

function getManualFallbackValues(): { spent: number; budget: number } | undefined {
	const { manualSpent, manualBudget } = getConfig();
	if (typeof manualSpent === 'number' && Number.isFinite(manualSpent) && typeof manualBudget === 'number' && Number.isFinite(manualBudget)) {
		return {
			spent: manualSpent,
			budget: manualBudget
		};
	}
	return undefined;
}

function parseManualBudgetText(input: string): { spent: number; budget: number } | undefined {
	const moneyMatches = Array.from(input.matchAll(/\$\s*([0-9]+(?:[.,][0-9]+)?)/g));
	if (moneyMatches.length < 2) {
		return undefined;
	}

	const spent = Number.parseFloat(moneyMatches[0][1].replace(',', '.'));
	const budget = Number.parseFloat(moneyMatches[1][1].replace(',', '.'));
	if (!Number.isFinite(spent) || !Number.isFinite(budget)) {
		return undefined;
	}

	return {
		spent,
		budget
	};
}

async function resolveAuthAndConfig(
	context: vscode.ExtensionContext,
	allowInteractiveLogin: boolean
): Promise<{ token: string; org: string; skuFilter: string; authSource: 'vscode-github' | 'secret' | 'settings' | 'env' }> {
	const { org, skuFilter } = getConfig();

	const fromSecretStorage = await context.secrets.get(SECRET_KEY);
	const fromSettings = vscode.workspace.getConfiguration('copilotSpentStatus').get<string>('githubToken', '').trim();
	const fromEnv = process.env.GITHUB_TOKEN?.trim() ?? '';
	if (fromSecretStorage?.trim()) {
		return { token: fromSecretStorage.trim(), org, skuFilter, authSource: 'secret' };
	}
	if (fromSettings) {
		return { token: fromSettings, org, skuFilter, authSource: 'settings' };
	}
	if (fromEnv) {
		return { token: fromEnv, org, skuFilter, authSource: 'env' };
	}

	const session = await getGitHubSession(org, allowInteractiveLogin);
	if (session?.accessToken) {
		return { token: session.accessToken, org, skuFilter, authSource: 'vscode-github' };
	}

	throw new Error(
		'Нет авторизации. Для личного аккаунта задайте fine-grained PAT через "Copilot Spent: Set GitHub Token". ' +
		'Для org можно использовать "Connect GitHub Account".'
	);
}

async function getGitHubSession(org: string, interactive: boolean): Promise<vscode.AuthenticationSession | undefined> {
	const scopes = getAuthScopes(org);
	const existing = await vscode.authentication.getSession(AUTH_PROVIDER_ID, scopes, { silent: true });
	if (existing) {
		return existing;
	}

	if (!interactive) {
		return undefined;
	}

	return vscode.authentication.getSession(AUTH_PROVIDER_ID, scopes, {
		createIfNone: {
			detail: org
				? 'Copilot Spent Status needs GitHub auth to read organization billing usage and budgets.'
				: 'Copilot Spent Status needs GitHub auth to read your billing usage and budgets.'
		}
	});
}

function getAuthScopes(org: string): string[] {
	if (org) {
		return ['read:org'];
	}
	return [];
}

async function fetchSpendAndBudget(token: string, org: string, skuFilter: string): Promise<FetchResult> {
	if (org) {
		return fetchOrgBilling(token, org, skuFilter);
	}

	return fetchUserBilling(token, skuFilter);
}

async function fetchOrgBilling(token: string, org: string, skuFilter: string): Promise<FetchResult> {
	const orgId = encodeURIComponent(org);

	// Try usage/summary first (Enhanced Billing Platform), fall back to usage
	let spent: number | undefined;
	let breakdown: Array<{ product: string; amount: number }> = [];
	const summaryPaths = [
		`/organizations/${orgId}/settings/billing/premium_request/usage`,
		`/organizations/${orgId}/settings/billing/usage/summary`,
		`/organizations/${orgId}/settings/billing/usage`
	];

	for (const path of summaryPaths) {
		try {
			const raw = await githubRequest(token, path);
			if (path.includes('/premium_request/usage')) {
				spent = extractTotalAmountFromUsageItems(raw);
				breakdown = extractProductBreakdownFromUsageItems(raw, true, skuFilter);
			} else {
				spent = extractSpent(raw, skuFilter);
				breakdown = extractProductBreakdownFromUsageItems(raw, false, skuFilter);
			}
			if (spent !== undefined) {
				break;
			}
		} catch (error) {
			if (error instanceof HttpError && (error.status === 404 || error.status === 403)) {
				continue;
			}
			throw error;
		}
	}

	if (spent === undefined) {
		throw new Error(
			`Не удалось получить usage данные для организации "${org}". ` +
			'Проверьте: (1) название org, (2) права owner/billing manager, (3) что org на Enhanced Billing Platform.'
		);
	}

	// Budgets — documented for orgs
	let budget: number | undefined;
	let budgetLabel: string | undefined;
	try {
		const budgetsRaw = await githubRequest(token, `/organizations/${orgId}/settings/billing/budgets`);
		const extracted = extractBudget(budgetsRaw, skuFilter);
		budget = extracted.budget;
		budgetLabel = extracted.label;
	} catch (error) {
		if (!(error instanceof HttpError && (error.status === 403 || error.status === 404))) {
			throw error;
		}
	}

	return { spent, budget, matchedBudgetLabel: budgetLabel, source: 'org', breakdown };
}

async function fetchUserBilling(token: string, skuFilter: string): Promise<FetchResult> {
	const login = await getAuthenticatedLogin(token);
	if (!login) {
		throw new Error(
			'Не удалось определить GitHub login. Проверьте токен и его валидность.'
		);
	}

	const encodedLogin = encodeURIComponent(login);

	const path = `/users/${encodedLogin}/settings/billing/premium_request/usage`;
	let spent: number | undefined;
	let breakdown: Array<{ product: string; amount: number }> = [];

	try {
		const raw = await githubRequest(token, path);
		spent = extractTotalAmountFromUsageItems(raw);
		breakdown = extractProductBreakdownFromUsageItems(raw, true, skuFilter);
	} catch (error) {
		if (error instanceof HttpError && error.status === 403) {
			throw new Error(
				'GitHub вернул 403 для billing API. Для личного аккаунта нужен fine-grained PAT с разрешением "Plan" (read). ' +
				'OAuth-токен из VS Code GitHub login НЕ имеет доступа к billing API. ' +
				'Создайте PAT: GitHub → Settings → Developer settings → Fine-grained tokens → ' +
				'Account permissions → Plan: Read-only. Затем задайте его через "Copilot Spent: Set GitHub Token".'
			);
		}
		if (error instanceof HttpError && error.status === 404) {
			throw new Error(
				'Endpoint /users/{login}/settings/billing/premium_request/usage недоступен (404) для этого аккаунта. '
				+ 'Проверьте корректность аккаунта и доступ к Enhanced Billing Platform.'
			);
		}
		throw error;
	}

	if (spent === undefined) {
		throw new Error('User billing API: не удалось определить сумму трат из premium_request/usage.');
	}

	// Budget API does NOT exist for personal accounts — only for orgs/enterprises.
	// For personal users, budget comes from manual settings only.
	const manualValues = getManualFallbackValues();
	return {
		spent,
		budget: manualValues?.budget,
		matchedBudgetLabel: manualValues?.budget !== undefined ? 'manual setting' : undefined,
		source: 'user',
		breakdown
	};
}

async function getAuthenticatedLogin(token: string): Promise<string | undefined> {
	try {
		const payload = await githubRequest(token, '/user');
		if (isObjectRecord(payload) && typeof payload.login === 'string') {
			return payload.login;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

async function githubRequest(token: string, path: string): Promise<unknown> {
	const response = await requestJson(`https://api.github.com${path}`, {
		headers: buildGitHubHeaders(token)
	});

	if (!response.ok) {
		const responseText = response.body;
		throw new HttpError(response.status, `${response.status} ${response.statusText}: ${responseText.slice(0, 500)}`);
	}

	return parseJson(response.body);
}

async function probeEndpoint(token: string, path: string): Promise<{ status: number; statusText: string; bodySnippet?: string }> {
	const response = await requestJson(`https://api.github.com${path}`, {
		headers: buildGitHubHeaders(token)
	});

	return {
		status: response.status,
		statusText: response.statusText,
		bodySnippet: response.ok ? undefined : response.body.slice(0, 300)
	};
}

function buildGitHubHeaders(token: string): Record<string, string> {
	return {
		'Accept': 'application/vnd.github+json',
		'Authorization': `Bearer ${token}`,
		'X-GitHub-Api-Version': API_VERSION,
		'User-Agent': USER_AGENT
	};
}

async function requestJson(url: string, options: { headers: Record<string, string> }): Promise<{ ok: boolean; status: number; statusText: string; body: string }> {
	const agent = getProxyAgentFromVsCodeSettings();

	return new Promise((resolve, reject) => {
		const request = https.request(url, {
			method: 'GET',
			headers: options.headers,
			agent: agent as https.Agent | undefined
		}, (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer | string) => {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			});
			response.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf8');
				resolve({
					ok: (response.statusCode ?? 0) >= 200 && (response.statusCode ?? 0) < 300,
					status: response.statusCode ?? 0,
					statusText: response.statusMessage ?? 'Unknown',
					body
				});
			});
		});

		request.on('error', (error) => {
			reject(new Error(`Network error while calling GitHub API: ${getErrorMessage(error)}`));
		});

		request.end();
	});
}

function getProxyAgentFromVsCodeSettings(): unknown | undefined {
	const proxyConfig = getProxyConfigFromVsCodeSettings();
	if (!proxyConfig.enabled || !proxyConfig.proxyUrl) {
		return undefined;
	}

	const cacheKey = `${proxyConfig.proxyUrl}|${proxyConfig.strictSSL}`;
	if (proxyAgentCache?.key === cacheKey) {
		return proxyAgentCache.agent;
	}

	const agent = new HttpsProxyAgent(proxyConfig.proxyUrl, {
		rejectUnauthorized: proxyConfig.strictSSL
	});

	proxyAgentCache = {
		key: cacheKey,
		agent
	};

	return agent;
}

function getProxyConfigFromVsCodeSettings(): { enabled: boolean; proxySupport: string; proxyUrl: string; strictSSL: boolean } {
	const httpConfig = vscode.workspace.getConfiguration('http');
	const proxySupport = httpConfig.get<string>('proxySupport', 'override');
	if (proxySupport === 'off') {
		return {
			enabled: false,
			proxySupport,
			proxyUrl: '',
			strictSSL: httpConfig.get<boolean>('proxyStrictSSL', true)
		};
	}

	const proxyUrl = httpConfig.get<string>('proxy', '').trim();
	const strictSSL = httpConfig.get<boolean>('proxyStrictSSL', true);

	return {
		enabled: proxyUrl.length > 0,
		proxySupport,
		proxyUrl,
		strictSSL
	};
}

function getProxyDebugLine(): string {
	const config = getProxyConfigFromVsCodeSettings();
	if (config.proxySupport === 'off') {
		return 'disabled (http.proxySupport=off)';
	}
	if (!config.proxyUrl) {
		return `not configured (http.proxy empty, proxySupport=${config.proxySupport})`;
	}
	return `enabled (${config.proxyUrl}, strictSSL=${config.strictSSL}, proxySupport=${config.proxySupport})`;
}

function parseJson(value: string): unknown {
	if (!value) {
		return {};
	}
	try {
		return JSON.parse(value) as unknown;
	} catch {
		throw new Error('GitHub API returned invalid JSON response.');
	}
}

function extractSpent(payload: unknown, skuFilter: string): number | undefined {
	// Enhanced Billing Platform response formats:
	//
	// /premium_request/usage:
	//   { "usageItems": [{ "product": "Copilot", "sku": "Copilot Premium Request",
	//     "model": "GPT-5", "unitType": "requests", "pricePerUnit": 0.04,
	//     "grossQuantity": 100, "grossAmount": 4, "netQuantity": 100, "netAmount": 4 }] }
	//
	// /usage (detailed, all products):
	//   { "usageItems": [{ "date": "2023-08-01", "product": "Actions", "sku": "Actions Linux",
	//     "quantity": 100, "grossAmount": 0.8, "netAmount": 0.8, "repositoryName": "..." }] }
	//
	// /usage/summary (aggregated, all products):
	//   { "usageItems": [{ "product": "Actions", "sku": "actions_linux",
	//     "grossQuantity": 1000, "grossAmount": 8, "netQuantity": 1000, "netAmount": 8 }] }
	if (isObjectRecord(payload) && Array.isArray(payload.usageItems)) {
		const items = payload.usageItems.filter(isObjectRecord);
		const normalizedFilter = skuFilter.toLowerCase();

		if (items.length === 0) {
			return 0;
		}

		// Sum netAmount for matching items (copilot/premium_request)
		let matchedTotal = 0;
		let hasMatch = false;
		for (const item of items) {
			const itemText = [
				asString(item.product),
				asString(item.sku),
				asString(item.unitType)
			].filter(Boolean).join(' ').toLowerCase();

			if (itemText.includes(normalizedFilter) || itemText.includes('copilot')) {
				const amount = toNumber(item.netAmount) ?? toNumber(item.grossAmount) ?? toNumber(item.net_amount) ?? toNumber(item.gross_amount);
				if (amount !== undefined) {
					matchedTotal += amount;
					hasMatch = true;
				}
			}
		}

		if (hasMatch) {
			return matchedTotal;
		}

		// Fallback: sum all items if no copilot-specific match
		let total = 0;
		let anyAmount = false;
		for (const item of items) {
			const amount = toNumber(item.netAmount) ?? toNumber(item.grossAmount) ?? toNumber(item.net_amount) ?? toNumber(item.gross_amount);
			if (amount !== undefined) {
				total += amount;
				anyAmount = true;
			}
		}
		if (anyAmount) {
			return total;
		}

		// New billing periods may return usageItems without amount fields yet.
		// In this case we treat spend as zero instead of failing refresh.
		return 0;
	}

	// Generic fallback: walk all nodes looking for spent-like fields
	const candidates: number[] = [];
	const fallbackCandidates: number[] = [];

	visitNodes(payload, (node) => {
		if (!isObjectRecord(node)) {
			return;
		}

		const relevance = JSON.stringify(node).toLowerCase().includes(skuFilter);
		const objectSpent = pickFirstNumber(node, [
			'spent',
			'total_spend',
			'totalSpent',
			'netAmount',
			'grossAmount',
			'net_amount',
			'gross_amount',
			'usage_cost',
			'cost',
			'amount'
		]);
		if (objectSpent !== undefined) {
			if (relevance) {
				candidates.push(objectSpent);
			} else {
				fallbackCandidates.push(objectSpent);
			}
		}
	});

	if (candidates.length > 0) {
		return candidates[0];
	}

	if (fallbackCandidates.length > 0) {
		return fallbackCandidates[0];
	}

	return undefined;
}

function extractTotalAmountFromUsageItems(payload: unknown): number | undefined {
	if (!isObjectRecord(payload) || !Array.isArray(payload.usageItems)) {
		return undefined;
	}

	if (payload.usageItems.length === 0) {
		return 0;
	}

	let total = 0;
	let hasAmount = false;
	for (const item of payload.usageItems) {
		if (!isObjectRecord(item)) {
			continue;
		}

		const amount = toNumber(item.netAmount) ?? toNumber(item.grossAmount) ?? toNumber(item.net_amount) ?? toNumber(item.gross_amount);
		if (amount !== undefined) {
			total += amount;
			hasAmount = true;
		}
	}

	if (hasAmount) {
		return total;
	}

	// Some responses at the beginning of billing period can contain usageItems
	// without amount fields yet. Treat as zero spend.
	return 0;
}

function extractProductBreakdownFromUsageItems(payload: unknown, includeAllProducts: boolean, skuFilter: string): Array<{ product: string; amount: number }> {
	if (!isObjectRecord(payload) || !Array.isArray(payload.usageItems)) {
		return [];
	}

	const totals = new Map<string, number>();
	const normalizedFilter = skuFilter.toLowerCase();

	for (const item of payload.usageItems) {
		if (!isObjectRecord(item)) {
			continue;
		}

		const itemText = [
			asString(item.product),
			asString(item.sku),
			asString(item.unitType)
		].filter(Boolean).join(' ').toLowerCase();

		if (!includeAllProducts && !(itemText.includes(normalizedFilter) || itemText.includes('copilot'))) {
			continue;
		}

		const amount = toNumber(item.netAmount) ?? toNumber(item.grossAmount) ?? toNumber(item.net_amount) ?? toNumber(item.gross_amount);
		if (amount === undefined || amount <= 0) {
			continue;
		}

		const productName = asString(item.product) ?? asString(item.sku) ?? 'Unknown';
		totals.set(productName, (totals.get(productName) ?? 0) + amount);
	}

	return Array.from(totals.entries())
		.map(([product, amount]) => ({ product, amount }))
		.sort((a, b) => b.amount - a.amount);
}

function extractBudget(payload: unknown, skuFilter: string): { budget?: number; label?: string } {
	if (payload === undefined) {
		return {};
	}

	if (!isObjectRecord(payload) || !Array.isArray(payload.budgets)) {
		return {};
	}

	const normalizedFilter = skuFilter.toLowerCase();
	const budgets = payload.budgets.filter(isObjectRecord);
	const matchingBudget = budgets.find((budget) => JSON.stringify(budget).toLowerCase().includes(normalizedFilter));
	const fallbackBudget = budgets[0];
	const selected = matchingBudget ?? fallbackBudget;

	if (!selected) {
		return {};
	}

	const budgetAmount = toNumber(selected.budget_amount) ?? toNumber(selected.budgetAmount) ?? toNumber(selected.amount);
	const label =
		(Array.isArray(selected.budget_product_skus) ? selected.budget_product_skus.join(', ') : undefined) ??
		(asString(selected.budget_product_sku)) ??
		(asString(selected.budget_scope));

	return {
		budget: budgetAmount,
		label
	};
}

function pickFirstNumber(record: Record<string, unknown>, keys: string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		const numeric = toNumber(value);
		if (numeric !== undefined) {
			return numeric;
		}
	}
	return undefined;
}

function visitNodes(value: unknown, visitor: (node: unknown) => void): void {
	visitor(value);
	if (Array.isArray(value)) {
		for (const item of value) {
			visitNodes(item, visitor);
		}
		return;
	}

	if (isObjectRecord(value)) {
		for (const child of Object.values(value)) {
			visitNodes(child, visitor);
		}
	}
}

function formatUsd(value: number): string {
	return new Intl.NumberFormat('en-US', {
		style: 'currency',
		currency: 'USD',
		maximumFractionDigits: 2
	}).format(value);
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string') {
		const normalized = Number(value.replace(/[^0-9.-]/g, ''));
		if (Number.isFinite(normalized)) {
			return normalized;
		}
	}
	return undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

class HttpError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message);
	}
}
