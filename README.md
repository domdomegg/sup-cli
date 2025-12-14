# sup-cli

Simple process supervisor with socket-based control. Start, stop, and monitor multiple services.

## Features

- Socket-based daemon with CLI client
- Health checks (port or HTTP)
- Auto-restart on failure with exponential backoff
- Dependency ordering between services
- File-based status and logs (Claude-friendly)
- Watch mode for live reload
- dotenv support

## Installation

```bash
npm install -g sup-cli
```

## Usage

Create a `sup.config.ts` (or `.js`, `.json`) in your project:

```typescript
import type { Config } from 'sup-cli';

export default {
  services: [
    {
      name: 'web',
      command: 'npm run start:web',
      healthCheck: { type: 'port', port: 3000 },
    },
    {
      name: 'api',
      command: 'npm run start:api',
      healthCheck: { type: 'http', url: 'http://localhost:4000/health' },
      dependsOn: ['db'],
    },
    {
      name: 'db',
      command: 'docker run postgres',
      healthCheck: { type: 'port', port: 5432 },
    },
  ],
} satisfies Config;
```

Then run:

```bash
sup up        # Start all services (foreground)
sup up -d     # Start as daemon (background)
sup down      # Stop daemon
sup status    # Show service status
sup logs web  # View logs for a service
sup restart api  # Restart a service
sup kill      # Force kill everything (cleanup)
```

## Configuration

### Service options

| Option | Type | Description |
|--------|------|-------------|
| `name` | string | Service name (required) |
| `command` | string | Command to run (required) |
| `cwd` | string | Working directory |
| `env` | object | Environment variables |
| `healthCheck` | object | Health check config |
| `dependsOn` | string[] | Services to wait for before starting |
| `restartPolicy` | 'always' \| 'on-failure' \| 'never' | When to restart (default: 'on-failure') |
| `maxRestarts` | number | Max restart attempts (default: 10) |
| `watch` | string[] | Glob patterns to watch for live reload |

### Health check types

```typescript
// Port check - service is healthy when port is listening
{ type: 'port', port: 3000 }

// HTTP check - service is healthy when URL returns 2xx
{ type: 'http', url: 'http://localhost:3000/health' }

// No health check - consider healthy immediately
{ type: 'none' }
```

## File-based status

Status is written to `.sup/status.json`:

```json
{
  "daemon": { "pid": 12345, "startedAt": "2024-12-14T12:00:00Z" },
  "services": {
    "web": { "status": "healthy", "pid": 12346, "restarts": 0 },
    "api": { "status": "starting", "pid": 12347, "restarts": 0 }
  }
}
```

Logs are written to `.sup/logs/{service}.log`.

This makes it easy for AI assistants (like Claude) to read status and debug issues.

## Contributing

Pull requests are welcomed on GitHub! To get started:

1. Install Git and Node.js
2. Clone the repository
3. Install dependencies with `npm install`
4. Run `npm run test` to run tests
5. Build with `npm run build`

## Releases

Versions follow the [semantic versioning spec](https://semver.org/).

To release:

1. Use `npm version <major | minor | patch>` to bump the version
2. Run `git push --follow-tags` to push with tags
3. Wait for GitHub Actions to publish to the NPM registry.
