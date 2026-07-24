# Host agent bridge

A VS Code workspace extension running inside a dev container cannot bypass the
container's namespaces to inspect the physical Remote-SSH host. Remote Health uses
an explicit Unix-socket mount for this topology:

```text
Remote host agent → user-owned Unix socket → bind-mounted directory → extension
```

This is an initial manual workflow. A later native agent package can automate
installation and user-service management while retaining the same `/v1/snapshot`
protocol.

## Prerequisites

- A Linux or macOS Remote-SSH host
- Node.js 22 or newer on the host
- Matching host and container user IDs, because the socket is mode `0600`
- A packaged `dist/agent.js` copied to the host

## Start the agent on the Remote-SSH host

Run these commands on the host, outside the dev container:

```sh
install -d -m 700 "$HOME/.remote-health/run"
openssl rand -hex 32 > "$HOME/.remote-health/run/token"
chmod 600 "$HOME/.remote-health/run/token"

REMOTE_HEALTH_SOCKET="$HOME/.remote-health/run/agent.sock" \
REMOTE_HEALTH_TOKEN_FILE="$HOME/.remote-health/run/token" \
node /path/to/remote-health/dist/agent.js
```

The agent removes a stale socket at the configured path, binds a new socket with
mode `0600`, and removes it on a normal shutdown. Use a dedicated directory and do
not point `REMOTE_HEALTH_SOCKET` at an unrelated path.

For persistent use, place the command in a systemd user service or equivalent
per-user supervisor. It does not require root privileges.

## Mount the runtime directory

Add a bind mount to `devcontainer.json`. Substitute the absolute host path because
dev-container mount interpolation varies by environment:

```json
{
  "mounts": [
    "source=/home/USER/.remote-health/run,target=/run/remote-health,type=bind"
  ],
  "settings": {
    "remoteHealth.agent.socketPath": "/run/remote-health/agent.sock",
    "remoteHealth.agent.tokenFilePath": "/run/remote-health/token"
  }
}
```

Rebuild the container and reload VS Code. The tooltip should report the hostname of
the Remote-SSH host and `host scope`. If it still reports `container scope`, inspect
the socket and token paths from a terminal inside the container.

## Security properties

- The agent is unprivileged and runs as the SSH user.
- The socket and token are accessible only to their owner by default.
- The token is kept in a mounted file, not in VS Code settings.
- The endpoint accepts only authenticated `GET /v1/snapshot` requests.
- It has response-size and request timeouts on the extension side.
- It does not expose process lists, environment variables, or command execution.
- It does not listen on a LAN interface.

Do not mount the runtime directory into untrusted containers. Any process that can
read the token and open the socket can read host health metrics.

## Current limitations

- The manual host agent requires Node.js; a signed native binary is planned.
- Socket permissions assume compatible host/container user IDs.
- Windows host bridging needs a named-pipe or authenticated TCP transport.
- Changing the configured socket or token path requires a window reload.
- Automatic install, update, repair, and uninstall commands are not implemented yet.
