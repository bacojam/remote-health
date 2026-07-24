import * as http from 'node:http';
import { MetricsCollector } from './collector';
import { protocolVersion } from './protocol';

const token = process.env.REMOTE_HEALTH_TOKEN;
if (!token) {
	throw new Error('REMOTE_HEALTH_TOKEN is required');
}

const collector = new MetricsCollector();
let collection: Promise<unknown> | undefined;

const server = http.createServer(async (request, response) => {
	if (request.method !== 'GET' || request.url !== '/v1/snapshot'
		|| request.headers.authorization !== `Bearer ${token}`) {
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

server.listen(0, '127.0.0.1', () => {
	const address = server.address();
	if (typeof address !== 'object' || !address) {
		throw new Error('Metrics agent failed to bind');
	}
	process.send?.({ type: 'ready', protocolVersion, port: address.port });
});

process.on('disconnect', () => server.close());
process.on('SIGTERM', () => server.close());
