import * as assert from 'node:assert';
import * as path from 'node:path';
import { AgentClient } from '../agentClient';
import { protocolVersion } from '../protocol';

suite('AgentClient', () => {
	test('collects a valid snapshot from the bundled agent', async () => {
		const client = new AgentClient(path.resolve(process.cwd(), 'dist', 'agent.js'));
		try {
			await client.start();
			const snapshot = await client.collect();

			assert.strictEqual(snapshot.protocolVersion, protocolVersion);
			assert.ok(snapshot.identity.hostname);
			assert.ok(snapshot.cpu.value >= 0 && snapshot.cpu.value <= 100);
			assert.ok(snapshot.memory.totalBytes > 0);
			assert.ok(snapshot.memory.usedBytes >= 0);
			assert.ok(snapshot.collectionDurationMs >= 0);
		} finally {
			client.dispose();
		}
	});
});
