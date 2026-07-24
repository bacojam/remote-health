import * as vscode from 'vscode';
import { Thresholds } from './protocol';

export interface RemoteHealthConfiguration {
	pollIntervalSeconds: number;
	displayMode: 'icon' | 'compact' | 'detailed';
	flash: boolean;
	consecutiveSamples: number;
	thresholds: Thresholds;
	agent: {
		socketPath: string;
		tokenFilePath: string;
	};
}

export function readConfiguration(): RemoteHealthConfiguration {
	const configuration = vscode.workspace.getConfiguration('remoteHealth');
	return {
		pollIntervalSeconds: configuration.get('pollIntervalSeconds', 5),
		displayMode: configuration.get('displayMode', 'compact'),
		flash: configuration.get('alerts.flash', true),
		consecutiveSamples: configuration.get('alerts.consecutiveSamples', 3),
		agent: {
			socketPath: configuration.get('agent.socketPath', ''),
			tokenFilePath: configuration.get('agent.tokenFilePath', ''),
		},
		thresholds: {
			cpu: configuration.get('thresholds.cpuPercent', 85),
			memory: configuration.get('thresholds.memoryPercent', 85),
			battery: configuration.get('thresholds.batteryPercent', 25),
			temperature: configuration.get('thresholds.temperatureCelsius', 85),
			disk: configuration.get('thresholds.diskPercent', 90),
		},
	};
}
