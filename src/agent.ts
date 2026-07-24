import * as http from 'node:http';
import { promises as fs, readFileSync, rmSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { MetricsCollector } from './collector';
import { protocolVersion } from './protocol';

const token = process.env.REMOTE_HEALTH_TOKEN
	?? (process.env.REMOTE_HEALTH_TOKEN_FILE
		? readFileSync(process.env.REMOTE_HEALTH_TOKEN_FILE, 'utf8').trim()
		: undefined);
if (!token) {
	throw new Error('REMOTE_HEALTH_TOKEN is required');
}

const collector = new MetricsCollector();
let collection: Promise<unknown> | undefined;

const server = http.createServer(async (request, response) => {
	if (request.method !== 'GET' || request.url !== '/v1/snapshot'
		|| !tokensEqual(request.headers.authorization ?? '', `Bearer ${token}`)) {
		response.writeHead(404).end();
		return;
	}
	try {
		collection ??= collector.collect().finally(() => collection = undefined);
		const snapshot = await collection;
		response.writeHead(200, {
			'content-type': 'application/json',
			'cache-control': 'no-store',
			'content-security-policy': "default-src 'none'",
		});
		response.end(JSON.stringify(snapshot));
	} catch (error) {
		response.writeHead(500, { 'content-type': 'application/json' });
		response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
	}
});

const socketPath = process.env.REMOTE_HEALTH_SOCKET;
if (socketPath && process.platform === 'win32') {
	throw new Error('Unix socket host-agent mode is not supported on Windows');
}
if (socketPath) {
	rmSync(socketPath, { force: true });
}

const onListening = () => {
	const address = server.address();
	if (!address) {
		throw new Error('Metrics agent failed to bind');
	}
	if (typeof address === 'object') {
		process.send?.({ type: 'ready', protocolVersion, port: address.port });
	} else {
		void fs.chmod(address, 0o600);
		process.send?.({ type: 'ready', protocolVersion, socketPath: address });
	}
};
if (socketPath) {
	server.listen(socketPath, onListening);
} else {
	server.listen(0, '127.0.0.1', onListening);
}

const close = () => server.close(() => {
	if (socketPath) { void fs.rm(socketPath, { force: true }); }
});
process.on('disconnect', close);
process.on('SIGTERM', close);

function tokensEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
