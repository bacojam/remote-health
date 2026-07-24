import * as assert from 'node:assert';
import { AlertTracker } from '../alerts';
import { HealthSnapshot, Thresholds } from '../protocol';

const thresholds: Thresholds = {
	cpu: 85,
	memory: 85,
	battery: 25,
	temperature: 85,
	disk: 90,
};

suite('AlertTracker', () => {
	test('debounces high resource usage', () => {
		const tracker = new AlertTracker();
		const snapshot = createSnapshot({ cpu: 90 });

		assert.deepStrictEqual(tracker.evaluate(snapshot, thresholds, 3), []);
		assert.deepStrictEqual(tracker.evaluate(snapshot, thresholds, 3), []);
		assert.deepStrictEqual(
			tracker.evaluate(snapshot, thresholds, 3).map(alert => alert.metric),
			['cpu'],
		);
	});

	test('uses hysteresis before recovering', () => {
		const tracker = new AlertTracker();
		tracker.evaluate(createSnapshot({ memory: 90 }), thresholds, 1);

		assert.deepStrictEqual(
			tracker.evaluate(createSnapshot({ memory: 83 }), thresholds, 1).map(alert => alert.metric),
			['memory'],
		);
		assert.deepStrictEqual(tracker.evaluate(createSnapshot({ memory: 79 }), thresholds, 1), []);
	});

	test('alerts immediately for a discharging battery', () => {
		const tracker = new AlertTracker();

		assert.deepStrictEqual(
			tracker.evaluate(createSnapshot({ battery: 20, charging: false }), thresholds, 3)
				.map(alert => alert.metric),
			['battery'],
		);
	});

	test('does not alert for a charging battery', () => {
		const tracker = new AlertTracker();

		assert.deepStrictEqual(
			tracker.evaluate(createSnapshot({ battery: 10, charging: true }), thresholds, 1),
			[],
		);
	});
});

function createSnapshot(values: {
	cpu?: number;
	memory?: number;
	battery?: number;
	charging?: boolean;
}): HealthSnapshot {
	return {
		protocolVersion: 1,
		agentVersion: 'test',
		timestamp: new Date(0).toISOString(),
		collectionDurationMs: 1,
		identity: {
			hostname: 'test',
			platform: 'linux',
			architecture: 'x64',
			scope: 'container',
		},
		cpu: { value: values.cpu ?? 10, unit: '%' },
		memory: {
			value: values.memory ?? 20,
			unit: '%',
			usedBytes: 20,
			availableBytes: 80,
			totalBytes: 100,
		},
		battery: values.battery === undefined ? undefined : {
			value: values.battery,
			unit: '%',
			charging: values.charging ?? false,
		},
		uptimeSeconds: 1,
		availability: {},
	};
}
