import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { CollectionScope, HealthSnapshot, MetricAvailability, protocolVersion } from './protocol';

const execFileAsync = promisify(execFile);
const agentVersion = '0.0.1';

interface CpuTimes { idle: number; total: number }
interface NetworkTotals { received: number; sent: number; timestamp: number }

export class MetricsCollector {
	private previousCpu = readCpuTimes();
	private previousNetwork?: NetworkTotals;

	async collect(): Promise<HealthSnapshot> {
		const started = performance.now();
		const memory = await readMemory();
		const currentCpu = readCpuTimes();
		const elapsedCpu = currentCpu.total - this.previousCpu.total;
		const elapsedIdle = currentCpu.idle - this.previousCpu.idle;
		this.previousCpu = currentCpu;

		const [battery, temperature, networkTotals, disk, scope] = await Promise.all([
			readBattery(),
			readTemperature(),
			readNetworkTotals(),
			readDisk(),
			detectScope(),
		]);

		const availability: Record<string, MetricAvailability> = {
			cpu: { available: true },
			memory: { available: true },
			battery: availabilityOf(battery, 'No battery was exposed by the operating system'),
			temperature: availabilityOf(temperature, 'No supported temperature sensor was exposed'),
			network: availabilityOf(networkTotals, 'Network byte counters are not supported on this platform'),
			disk: availabilityOf(disk, 'Filesystem capacity could not be read'),
		};

		return {
			protocolVersion,
			agentVersion,
			timestamp: new Date().toISOString(),
			collectionDurationMs: performance.now() - started,
			identity: {
				hostname: os.hostname(),
				platform: process.platform,
				architecture: process.arch,
				scope,
			},
			cpu: {
				value: elapsedCpu > 0 ? clamp((1 - elapsedIdle / elapsedCpu) * 100) : 0,
				unit: '%',
			},
			memory: {
				value: memory.total > 0 ? clamp(memory.used / memory.total * 100) : 0,
				unit: '%',
				usedBytes: memory.used,
				availableBytes: memory.total - memory.used,
				totalBytes: memory.total,
			},
			battery,
			temperature,
			network: this.toNetworkRate(networkTotals),
			disk,
			loadAverage: process.platform === 'win32' ? undefined : os.loadavg(),
			uptimeSeconds: os.uptime(),
			availability,
		};
	}

	private toNetworkRate(current?: NetworkTotals): HealthSnapshot['network'] {
		if (!current) { return undefined; }
		const previous = this.previousNetwork;
		this.previousNetwork = current;
		if (!previous || current.timestamp <= previous.timestamp) { return undefined; }
		const elapsedSeconds = (current.timestamp - previous.timestamp) / 1000;
		return {
			receivedPerSecond: Math.max(0, (current.received - previous.received) / elapsedSeconds),
			sentPerSecond: Math.max(0, (current.sent - previous.sent) / elapsedSeconds),
		};
	}
}

function availabilityOf(value: unknown, reason: string): MetricAvailability {
	return value === undefined ? { available: false, reason } : { available: true };
}

function readCpuTimes(): CpuTimes {
	let idle = 0;
	let total = 0;
	for (const cpu of os.cpus()) {
		idle += cpu.times.idle;
		total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
	}
	return { idle, total };
}

async function readMemory(): Promise<{ used: number; total: number }> {
	if (process.platform !== 'linux') {
		return { used: os.totalmem() - os.freemem(), total: os.totalmem() };
	}
	const candidates = [
		['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory.max'],
		['/sys/fs/cgroup/memory/memory.usage_in_bytes', '/sys/fs/cgroup/memory/memory.limit_in_bytes'],
	];
	for (const [usagePath, limitPath] of candidates) {
		try {
			const [usageRaw, limitRaw] = await Promise.all([
				fs.readFile(usagePath, 'utf8'),
				fs.readFile(limitPath, 'utf8'),
			]);
			const used = Number(usageRaw.trim());
			const total = Number(limitRaw.trim());
			if (Number.isFinite(used) && Number.isFinite(total) && total > 0 && total < os.totalmem()) {
				return { used: Math.min(used, total), total };
			}
		} catch { /* Try the next cgroup layout. */ }
	}
	return { used: os.totalmem() - os.freemem(), total: os.totalmem() };
}

async function readBattery(): Promise<HealthSnapshot['battery']> {
	try {
		if (process.platform === 'linux') {
			const entries = await fs.readdir('/sys/class/power_supply');
			const battery = entries.find(entry => /^BAT/i.test(entry));
			if (!battery) { return undefined; }
			const root = path.join('/sys/class/power_supply', battery);
			const [capacity, status] = await Promise.all([
				fs.readFile(path.join(root, 'capacity'), 'utf8'),
				fs.readFile(path.join(root, 'status'), 'utf8').catch(() => ''),
			]);
			return { value: Number(capacity.trim()), unit: '%', charging: /charging|full/i.test(status) };
		}
		if (process.platform === 'darwin') {
			const { stdout } = await execFileAsync('pmset', ['-g', 'batt'], { timeout: 1500 });
			const match = stdout.match(/(\d+)%/);
			if (match) {
				return { value: Number(match[1]), unit: '%', charging: /charging|charged/i.test(stdout) };
			}
		}
		if (process.platform === 'win32') {
			const command = '(Get-CimInstance Win32_Battery | Select-Object -First 1 EstimatedChargeRemaining,BatteryStatus | ConvertTo-Json -Compress)';
			const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { timeout: 2000 });
			const value = JSON.parse(stdout) as { EstimatedChargeRemaining?: number; BatteryStatus?: number };
			if (value.EstimatedChargeRemaining !== undefined) {
				return {
					value: value.EstimatedChargeRemaining,
					unit: '%',
					charging: value.BatteryStatus === 2 || value.BatteryStatus === 6,
				};
			}
		}
	} catch { /* The metric remains unavailable. */ }
	return undefined;
}

async function readTemperature(): Promise<HealthSnapshot['temperature']> {
	if (process.platform !== 'linux') { return undefined; }
	try {
		const zones = await fs.readdir('/sys/class/thermal');
		const temperatures = await Promise.all(zones.filter(zone => /^thermal_zone\d+$/.test(zone)).map(async zone => {
			const value = Number((await fs.readFile(path.join('/sys/class/thermal', zone, 'temp'), 'utf8')).trim());
			return value > 1000 ? value / 1000 : value;
		}));
		const valid = temperatures.filter(value => value > 0 && value < 150);
		return valid.length ? { value: Math.max(...valid), unit: '°C' } : undefined;
	} catch {
		return undefined;
	}
}

async function readNetworkTotals(): Promise<NetworkTotals | undefined> {
	if (process.platform !== 'linux') { return undefined; }
	try {
		const data = await fs.readFile('/proc/net/dev', 'utf8');
		let received = 0;
		let sent = 0;
		for (const line of data.split('\n').slice(2)) {
			const [name, values] = line.trim().split(':');
			if (!values || name === 'lo') { continue; }
			const fields = values.trim().split(/\s+/).map(Number);
			received += fields[0] || 0;
			sent += fields[8] || 0;
		}
		return { received, sent, timestamp: Date.now() };
	} catch {
		return undefined;
	}
}

async function readDisk(): Promise<HealthSnapshot['disk']> {
	try {
		const root = process.platform === 'win32' ? path.parse(process.cwd()).root : '/';
		const stats = await fs.statfs(root);
		const totalBytes = stats.blocks * stats.bsize;
		const availableBytes = stats.bavail * stats.bsize;
		const usedBytes = totalBytes - availableBytes;
		return { value: clamp(usedBytes / totalBytes * 100), unit: '%', usedBytes, totalBytes };
	} catch {
		return undefined;
	}
}

async function detectScope(): Promise<CollectionScope> {
	if (process.platform !== 'linux') { return 'host'; }
	try {
		await fs.access('/.dockerenv');
		return 'container';
	} catch { /* Continue with cgroup detection. */ }
	try {
		const cgroup = await fs.readFile('/proc/1/cgroup', 'utf8');
		return /docker|containerd|kubepods|libpod|lxc/i.test(cgroup) ? 'container' : 'host';
	} catch {
		return 'host';
	}
}

function clamp(value: number): number {
	return Math.max(0, Math.min(100, value));
}
