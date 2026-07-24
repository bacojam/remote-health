import { HealthSnapshot, Thresholds } from './protocol';

export type AlertMetric = 'cpu' | 'memory' | 'battery' | 'temperature' | 'disk';

export interface HealthAlert {
	metric: AlertMetric;
	label: string;
	value: number;
	unit: string;
}

export class AlertTracker {
	private readonly violations = new Map<AlertMetric, number>();
	private readonly active = new Set<AlertMetric>();

	evaluate(snapshot: HealthSnapshot, thresholds: Thresholds, consecutiveSamples: number): HealthAlert[] {
		const candidates: Array<HealthAlert & { violates: boolean; recovers: boolean; immediate?: boolean }> = [
			this.high('cpu', 'CPU', snapshot.cpu.value, '%', thresholds.cpu),
			this.high('memory', 'Memory', snapshot.memory.value, '%', thresholds.memory),
		];
		if (snapshot.battery) {
			candidates.push({
				metric: 'battery',
				label: 'Battery',
				value: snapshot.battery.value,
				unit: '%',
				violates: !snapshot.battery.charging && snapshot.battery.value <= thresholds.battery,
				recovers: snapshot.battery.charging || snapshot.battery.value >= thresholds.battery + 5,
				immediate: true,
			});
		}
		if (snapshot.temperature) {
			candidates.push(this.high('temperature', 'Temperature', snapshot.temperature.value, '°C', thresholds.temperature));
		}
		if (snapshot.disk) {
			candidates.push(this.high('disk', 'Disk', snapshot.disk.value, '%', thresholds.disk));
		}

		const present = new Set(candidates.map(candidate => candidate.metric));
		for (const metric of this.active) {
			if (!present.has(metric)) { this.active.delete(metric); }
		}

		for (const candidate of candidates) {
			if (this.active.has(candidate.metric)) {
				if (candidate.recovers) {
					this.active.delete(candidate.metric);
					this.violations.delete(candidate.metric);
				}
				continue;
			}
			if (!candidate.violates) {
				this.violations.delete(candidate.metric);
				continue;
			}
			const count = (this.violations.get(candidate.metric) ?? 0) + 1;
			this.violations.set(candidate.metric, count);
			if (candidate.immediate || count >= consecutiveSamples) {
				this.active.add(candidate.metric);
			}
		}

		return candidates
			.filter(candidate => this.active.has(candidate.metric))
			.map(({ metric, label, value, unit }) => ({ metric, label, value, unit }));
	}

	reset(): void {
		this.violations.clear();
		this.active.clear();
	}

	private high(metric: AlertMetric, label: string, value: number, unit: string, threshold: number) {
		return {
			metric,
			label,
			value,
			unit,
			violates: value >= threshold,
			recovers: value <= threshold - 5,
		};
	}
}
