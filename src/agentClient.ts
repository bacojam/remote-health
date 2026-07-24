import { ChildProcess, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import { promises as fs } from 'node:fs';
import { AgentReadyMessage, HealthSnapshot, protocolVersion } from './protocol';

export class AgentClient {
	private child?: ChildProcess;
	private port?: number;
	private token = randomBytes(32).toString('hex');

	constructor(
		private readonly agentPath: string,
		private readonly external?: { socketPath: string; tokenFilePath: string },
	) {}

	async start(): Promise<void> {
		if (this.child) { return; }
		if (this.external) {
			if (!this.external.socketPath || !this.external.tokenFilePath) {
				throw new Error('Both host-agent socketPath and tokenFilePath must be configured');
			}
			this.token = (await fs.readFile(this.external.tokenFilePath, 'utf8')).trim();
			if (!this.token) { throw new Error('The host-agent token file is empty'); }
			await this.collect();
			return;
		}
		this.child = fork(this.agentPath, [], {
			env: { ...process.env, REMOTE_HEALTH_TOKEN: this.token },
			stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
		});
		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('Metrics agent startup timed out')), 5000);
			const fail = (error: Error) => {
				clearTimeout(timer);
				reject(error);
			};
			this.child?.once('error', fail);
			this.child?.once('exit', code => fail(new Error(`Metrics agent exited (${code ?? 'unknown'})`)));
			this.child?.on('message', message => {
				if (!isReadyMessage(message)) { return; }
				clearTimeout(timer);
				if (message.protocolVersion !== protocolVersion) {
					reject(new Error(`Unsupported agent protocol ${message.protocolVersion}`));
					return;
				}
				this.port = message.port;
				resolve();
			});
		});
	}

	async collect(): Promise<HealthSnapshot> {
		if (!this.port && !this.external) { throw new Error('Metrics agent is not ready'); }
		return new Promise((resolve, reject) => {
			const request = http.get({
				...(this.external
					? { socketPath: this.external.socketPath }
					: { host: '127.0.0.1', port: this.port }),
				path: '/v1/snapshot',
				headers: { authorization: `Bearer ${this.token}` },
				timeout: 4000,
			}, response => {
				let body = '';
				response.setEncoding('utf8');
				response.on('data', chunk => {
					body += chunk;
					if (body.length > 256 * 1024) {
						request.destroy(new Error('Metrics agent response was too large'));
					}
				});
				response.on('end', () => {
					try {
						if (response.statusCode !== 200) {
							throw new Error(`Metrics agent returned HTTP ${response.statusCode}`);
						}
						const snapshot = JSON.parse(body) as HealthSnapshot;
						if (snapshot.protocolVersion !== protocolVersion) {
							throw new Error(`Unsupported snapshot protocol ${snapshot.protocolVersion}`);
						}
						resolve(snapshot);
					} catch (error) {
						reject(error);
					}
				});
			});
			request.once('timeout', () => request.destroy(new Error('Metrics agent request timed out')));
			request.once('error', reject);
		});
	}

	dispose(): void {
		this.child?.kill();
		this.child = undefined;
		this.port = undefined;
	}
}

function isReadyMessage(value: unknown): value is AgentReadyMessage {
	return typeof value === 'object' && value !== null
		&& (value as Partial<AgentReadyMessage>).type === 'ready'
		&& typeof (value as Partial<AgentReadyMessage>).port === 'number'
		&& typeof (value as Partial<AgentReadyMessage>).protocolVersion === 'number';
}
