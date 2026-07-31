import * as vscode from 'vscode';
import { AgentClient } from './agentClient';
import { HealthAlert, AlertTracker } from './alerts';
import { readConfiguration, RemoteHealthConfiguration } from './configuration';
import { HealthSnapshot } from './protocol';

let agent: AgentClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const status = vscode.window.createStatusBarItem('remote-health.status', vscode.StatusBarAlignment.Right, 10);
	status.name = 'Remote Health';
	status.command = 'remote-health.refresh';
	status.text = '$(pulse) Starting…';
	status.tooltip = 'Starting the Remote Health metrics agent';
	status.show();

	const initialConfiguration = readConfiguration();
	const externalAgent = initialConfiguration.agent.socketPath || initialConfiguration.agent.tokenFilePath
		? initialConfiguration.agent
		: undefined;
	agent = new AgentClient(context.asAbsolutePath('dist/agent.js'), externalAgent);
	const alertTracker = new AlertTracker();
	let pollTimer: NodeJS.Timeout | undefined;
	let flashTimer: NodeJS.Timeout | undefined;
	let collecting = false;

	const stopFlashing = () => {
		if (flashTimer) { clearInterval(flashTimer); }
		flashTimer = undefined;
		status.backgroundColor = undefined;
	};

	const render = (snapshot: HealthSnapshot, configuration: RemoteHealthConfiguration) => {
		const alerts = alertTracker.evaluate(snapshot, configuration.thresholds, configuration.consecutiveSamples);
		status.text = statusText(snapshot, configuration.displayMode, alerts.length > 0);
		status.tooltip = snapshotTooltip(snapshot, alerts);
		status.accessibilityInformation = {
			label: accessibilityLabel(snapshot, alerts),
			role: 'status',
		};
		stopFlashing();
		if (alerts.length > 0) {
			status.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
			if (configuration.flash) {
				let visible = true;
				flashTimer = setInterval(() => {
					visible = !visible;
					status.backgroundColor = visible
						? new vscode.ThemeColor('statusBarItem.warningBackground')
						: undefined;
				}, 800);
			}
		}
	};

	const refresh = async () => {
		if (collecting) { return; }
		collecting = true;
		try {
			const snapshot = await agent!.collect();
			render(snapshot, readConfiguration());
		} catch (error) {
			stopFlashing();
			status.text = '$(warning) Remote Health';
			status.tooltip = `Metrics unavailable: ${messageOf(error)}`;
			status.accessibilityInformation = { label: `Remote Health unavailable: ${messageOf(error)}`, role: 'status' };
		} finally {
			collecting = false;
		}
	};

	const schedule = () => {
		if (pollTimer) { clearInterval(pollTimer); }
		pollTimer = setInterval(() => void refresh(), readConfiguration().pollIntervalSeconds * 1000);
	};

	context.subscriptions.push(
		status,
		vscode.commands.registerCommand('remote-health.refresh', refresh),
		vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('remoteHealth')) {
				alertTracker.reset();
				schedule();
				void refresh();
			}
		}),
		{
			dispose: () => {
				if (pollTimer) { clearInterval(pollTimer); }
				stopFlashing();
				agent?.dispose();
			},
		},
	);

	try {
		await agent.start();
		schedule();
		await refresh();
	} catch (error) {
		status.text = '$(warning) Remote Health';
		status.tooltip = `Could not start the metrics agent: ${messageOf(error)}`;
	}
}

function statusText(snapshot: HealthSnapshot, mode: RemoteHealthConfiguration['displayMode'], warning: boolean): string {
	const icon = warning ? '$(warning)' : '$(pulse)';
	if (mode === 'icon') { return icon; }
	if (mode === 'detailed') {
		return `${icon} CPU ${snapshot.cpu.value.toFixed(0)}%  $(server) RAM ${snapshot.memory.value.toFixed(0)}%`;
	}
	return `${icon} ${snapshot.cpu.value.toFixed(0)}%  $(server) ${snapshot.memory.value.toFixed(0)}%`;
}

function snapshotTooltip(snapshot: HealthSnapshot, alerts: HealthAlert[]): vscode.MarkdownString {
	const tooltip = new vscode.MarkdownString(undefined, true);
	tooltip.supportHtml = true;
	const status = alerts.length ? '$(warning) Attention' : '$(pulse) Healthy';
	tooltip.appendMarkdown(`<table>\n<tr><td><strong>Remote Health</strong><br><small>${escapeHtml(snapshot.identity.scope)} scope</small></td><td align="right">${status}</td></tr>\n</table>\n\n`);
	tooltip.appendMarkdown('---\n\n**Usage**\n\n<table>\n<tbody>\n');
	tooltip.appendMarkdown(metricRow('CPU', `${snapshot.cpu.value.toFixed(1)}%`, 'Processor utilization'));
	tooltip.appendMarkdown(metricRow('Memory', `${snapshot.memory.value.toFixed(1)}%`, `${formatBytes(snapshot.memory.usedBytes)} / ${formatBytes(snapshot.memory.totalBytes)} used`));
	tooltip.appendMarkdown('</tbody>\n</table>\n\n');
	tooltip.appendMarkdown('**System details**\n\n<table>\n<tbody>\n');
	if (snapshot.battery) {
		tooltip.appendMarkdown(metricRow('Battery', `${snapshot.battery.value.toFixed(0)}%`, snapshot.battery.charging ? 'Charging' : 'Discharging'));
	}
	if (snapshot.temperature) {
		tooltip.appendMarkdown(metricRow('Temperature', `${snapshot.temperature.value.toFixed(1)}°C`));
	}
	if (snapshot.network) {
		tooltip.appendMarkdown(metricRow('Network', `↓ ${formatBytes(snapshot.network.receivedPerSecond)}/s · ↑ ${formatBytes(snapshot.network.sentPerSecond)}/s`));
	}
	if (snapshot.disk) {
		tooltip.appendMarkdown(metricRow('Root disk', `${snapshot.disk.value.toFixed(1)}% (${formatBytes(snapshot.disk.usedBytes)} / ${formatBytes(snapshot.disk.totalBytes)})`));
	}
	if (snapshot.loadAverage) {
		tooltip.appendMarkdown(metricRow('Load average', snapshot.loadAverage.map(value => value.toFixed(2)).join(' · ')));
	}
	tooltip.appendMarkdown(metricRow('Uptime', formatDuration(snapshot.uptimeSeconds)));
	tooltip.appendMarkdown('</tbody>\n</table>\n\n');
	tooltip.appendMarkdown(`**Source**<br><small>${wrapHtml(snapshot.identity.hostname)} · ${wrapHtml(`${snapshot.identity.platform}/${snapshot.identity.architecture}`)}</small>\n\n`);
	if (snapshot.identity.scope === 'container') {
		tooltip.appendMarkdown('_These are the resources visible to the dev container; physical host sensors require an explicit host-agent bridge._\n\n');
	}
	if (alerts.length) {
		tooltip.appendMarkdown(`**Attention**<br><small>${alerts.map(alert => `${escapeHtml(alert.label)} ${alert.value.toFixed(0)}${escapeHtml(alert.unit)}`).join(', ')}</small>\n\n`);
	}
	tooltip.appendMarkdown(`<small>Updated ${escapeHtml(new Date(snapshot.timestamp).toLocaleTimeString())} · collection ${snapshot.collectionDurationMs.toFixed(1)} ms</small>\n\n_Click to refresh._`);
	return tooltip;
}

function metricRow(label: string, value: string, detail?: string): string {
	const detailMarkup = detail ? `<br><small>${wrapHtml(detail)}</small>` : '';
	return `<tr><td>&nbsp;<strong>${escapeHtml(label)}</strong>${detailMarkup}&nbsp;</td><td align="right">&nbsp;<strong>${wrapHtml(value)}</strong>&nbsp;</td></tr>\n`;
}

function wrapHtml(value: string): string {
	return escapeHtml(value).replace(/([/\\._:@-])/g, '$1<wbr>');
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function accessibilityLabel(snapshot: HealthSnapshot, alerts: HealthAlert[]): string {
	const prefix = alerts.length
		? `Remote Health warning: ${alerts.map(alert => `${alert.label} ${alert.value.toFixed(0)} ${alert.unit}`).join(', ')}.`
		: 'Remote Health is normal.';
	return `${prefix} CPU ${snapshot.cpu.value.toFixed(0)} percent, memory ${snapshot.memory.value.toFixed(0)} percent, ${snapshot.identity.scope} scope.`;
}

export function formatBytes(value: number): string {
	if (!Number.isFinite(value) || value <= 0) { return '0 B'; }
	const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
	const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
	return `${(value / 1024 ** index).toFixed(index < 2 ? 0 : 1)} ${units[index]}`;
}

function formatDuration(seconds: number): string {
	if (seconds < 3600) { return `${Math.floor(seconds / 60)} min`; }
	if (seconds < 86400) { return `${(seconds / 3600).toFixed(1)} h`; }
	return `${(seconds / 86400).toFixed(1)} days`;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function deactivate(): void {
	agent?.dispose();
}
