# Remote Health

Remote Health adds lightweight environment metrics to the right side of the VS Code
status bar. It is designed for local windows, Remote-SSH sessions, and dev containers.

The compact status item shows CPU and memory usage. Hover over it for:

- CPU and memory pressure
- Battery level and charging state, when available
- Temperature, when available
- Network receive and transmit rates
- Root filesystem capacity
- Load average and uptime
- Hostname, operating system, architecture, and collection scope

Click the item or run **Remote Health: Refresh Now** to collect immediately.

## Collection scope

The tooltip always says either `host scope` or `container scope`.

- In a local or direct Remote-SSH window, the bundled agent measures that machine.
- In a dev container, the default agent measures resources visible to the container,
  including its cgroup memory limit when available.
- To measure the physical SSH host from a dev container, run the agent on the host
  and mount its Unix socket and token file into the container.

Container metrics are never presented as physical-host metrics. See
[Host agent bridge](docs/host-agent.md) for the current manual bridge procedure and
its security model.

## Alerts

The status item uses VS Code's theme-aware warning color when a threshold is crossed.
If enabled, it alternates the warning background without opening a modal notification.

High CPU, memory, temperature, and disk usage must persist for three samples by
default. Alerts recover five percentage points below their configured threshold,
which prevents flicker around a boundary. Low discharging battery alerts immediately.

## Settings

| Setting | Default | Purpose |
|---|---:|---|
| `remoteHealth.pollIntervalSeconds` | `5` | Core metric sampling interval |
| `remoteHealth.displayMode` | `compact` | `icon`, `compact`, or `detailed` status text |
| `remoteHealth.alerts.flash` | `true` | Alternate warning color during an alert |
| `remoteHealth.alerts.consecutiveSamples` | `3` | Samples required before a high-usage alert |
| `remoteHealth.thresholds.cpuPercent` | `85` | CPU alert threshold |
| `remoteHealth.thresholds.memoryPercent` | `85` | Memory alert threshold |
| `remoteHealth.thresholds.batteryPercent` | `25` | Discharging battery threshold |
| `remoteHealth.thresholds.temperatureCelsius` | `85` | Temperature alert threshold |
| `remoteHealth.thresholds.diskPercent` | `90` | Root filesystem threshold |
| `remoteHealth.agent.socketPath` | empty | Mounted external host-agent socket |
| `remoteHealth.agent.tokenFilePath` | empty | Mounted external host-agent token file |

Changing the agent socket settings requires reloading the extension window.

## Platform support

CPU, memory, disk, hostname, architecture, and uptime use portable Node.js APIs on
Linux, macOS, and Windows. Battery uses Linux sysfs, macOS `pmset`, or Windows CIM.
Temperature and byte-level network rates currently use Linux kernel interfaces.
Unavailable metrics are omitted from the tooltip.

The mounted host-agent bridge currently uses Unix sockets and therefore targets
Linux and macOS hosts. The default bundled loopback agent works on all three major
operating systems.

## Performance and security

Collection defaults to once every five seconds, allows only one in-flight sample,
and retains only the previous CPU and network counters. The bundled agent binds an
ephemeral `127.0.0.1` port and requires a random per-process bearer token. It exposes
one read-only endpoint and stops with the extension.

No telemetry or metric history leaves the machine.

## Development

```sh
npm run package
xvfb-run -a npm test  # Linux containers without a display
```
