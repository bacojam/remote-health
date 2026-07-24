import { ChildProcess, fork } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import { AgentReadyMessage, HealthSnapshot, protocolVersion } from './protocol';

export class AgentClient {
	private child?: ChildProcess;
	private port?: number;
	private readonly token = randomBytes(32).toString('hex');

	constructor(private readonly agentPath: string) {}

	async start(): Promise<void> {
		if (this.child) { return; }
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
		if (!this.port) { throw new Error('Metrics agent is not ready'); }
		return new Promise((resolve, reject) => {
			const request = http.get({
				host: '127.0.0.1',
				port: this.port,
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

// Kept local so secret comparisons remain constant-time when the client later
// accepts externally supplied host-agent credentials.
export function tokensEqual(left: string, right: string): boolean {
	const a = Buffer.from(left);
	const b = Buffer.from(right);
	return a.length === b.length && timingSafeEqual(a, b);
}
