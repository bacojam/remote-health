export const protocolVersion = 1;

export type CollectionScope = 'host' | 'container';

export interface MetricValue {
	value: number;
	unit: string;
}

export interface MetricAvailability {
	available: boolean;
	reason?: string;
}

export interface HealthSnapshot {
	protocolVersion: number;
	agentVersion: string;
	timestamp: string;
	collectionDurationMs: number;
	identity: {
		hostname: string;
		platform: NodeJS.Platform;
		architecture: string;
		scope: CollectionScope;
	};
	cpu: MetricValue;
	memory: MetricValue & {
		usedBytes: number;
		availableBytes: number;
		totalBytes: number;
	};
	battery?: MetricValue & { charging: boolean };
	temperature?: MetricValue;
	network?: {
		receivedPerSecond: number;
		sentPerSecond: number;
	};
	disk?: MetricValue & {
		usedBytes: number;
		totalBytes: number;
	};
	loadAverage?: number[];
	uptimeSeconds: number;
	availability: Record<string, MetricAvailability>;
}

export interface AgentReadyMessage {
	type: 'ready';
	protocolVersion: number;
	port: number;
}

export interface Thresholds {
	cpu: number;
	memory: number;
	battery: number;
	temperature: number;
	disk: number;
}
