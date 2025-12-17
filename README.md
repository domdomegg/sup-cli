# sup-cli

Simple process supervisor for local development. Manages multiple services with health checks, auto-restart, and unified logging.

## Quick Start

```bash
npm install sup-cli
```

Create `sup.config.ts`:

```typescript
import type {Config} from 'sup-cli';

export default {
  tasks: [
    { name: 'migrate', command: 'npm run migrate' },
  ],
  services: [
    { name: 'web', command: 'npm run dev', healthCheck: { type: 'port', port: 3000 }, dependsOn: ['migrate'] },
    { name: 'api', command: 'npm run api', healthCheck: { type: 'port', port: 4000 }, dependsOn: ['migrate'] },
  ],
} satisfies Config;
```

Start everything:

```bash
npx sup up
```

## Common Operations

```bash
# Start/stop
sup up              # Start all services (runs as daemon)
sup down            # Stop everything

# Check status
sup status          # See what's running, health, restarts

# Restart services
sup restart         # Restart all
sup restart web     # Restart just web

# View logs
sup logs            # All logs
sup logs web        # Just web logs
sup logs -f         # Follow all logs
sup logs web -f     # Follow web logs
sup logs -n100      # Last 100 lines

# Debugging
sup kill            # Force kill everything (useful after crashes)
```

## Dev Workflow

If your services don't already auto-reload (e.g., via nodemon, Next.js, Vite), you'll need to restart manually:

```bash
# Terminal 1: Start everything
sup up
sup logs -f         # Watch all logs

# Terminal 2: Work on code
# ... edit files ...
sup restart web     # Restart after changes

# When done
sup down
```

Add scripts to your `package.json`:

```json
{
  "scripts": {
    "start": "sup down; sup up",
    "stop": "sup down",
    "logs": "sup logs -f"
  }
}
```

## Configuration

### Tasks vs Services

- **Tasks** run once and exit. Use them for setup steps like database migrations, installing dependencies, or build steps.
- **Services** run continuously and are restarted if they crash. Use them for your actual application processes.

Both tasks and services can depend on each other. Services will wait for their task dependencies to complete before starting.

### Task Options

```typescript
type TaskConfig = {
  name: string;           // Task name
  command: string;        // Command to run
  cwd?: string;           // Working directory
  env?: Record<string, string>;  // Environment variables
  dependsOn?: string[];   // Wait for these tasks/services first
};
```

### Service Options

```typescript
type ServiceConfig = {
  name: string;           // Service name
  command: string;        // Command to run
  cwd?: string;           // Working directory
  env?: Record<string, string>;  // Environment variables
  healthCheck?: HealthCheck;     // How to check if healthy
  dependsOn?: string[];   // Wait for these tasks/services first
  restartPolicy?: 'always' | 'on-failure' | 'never';  // Default: 'on-failure'
  maxRestarts?: number;   // Give up after N restarts (default: 10)
};
```

### Health Checks

```typescript
// Port check - healthy when port is listening
{ type: 'port', port: 3000 }

// HTTP check - healthy when URL returns 2xx
{ type: 'http', url: 'http://localhost:3000/health' }

// No check - always considered healthy
{ type: 'none' }
```

### Environment Variables

Load from `.env` automatically, or specify a custom path:

```typescript
export default {
  dotenv: '.env.local',  // Optional, defaults to .env
  services: [...]
} satisfies Config;
```

### Dependencies

Services start in dependency order:

```typescript
services: [
  { name: 'db', command: 'docker run postgres', healthCheck: { type: 'port', port: 5432 } },
  { name: 'api', command: 'npm run api', dependsOn: ['db'] },  // Waits for db to be healthy
  { name: 'web', command: 'npm run web', dependsOn: ['api'] }, // Waits for api
]
```

## Files

sup creates a `.sup/` directory (add to `.gitignore`):

```
.sup/
├── sup.sock      # Unix socket for CLI communication
├── status.json   # Current status (readable by scripts/AI)
└── logs/
    ├── web.log
    └── api.log
```

The `status.json` is designed to be easily readable by scripts or AI assistants:

```json
{
  "daemon": { "pid": 12345 },
  "services": {
    "web": { "status": "healthy", "pid": 12346, "restarts": 0 },
    "api": { "status": "healthy", "pid": 12347, "restarts": 0 }
  }
}
```

## Contributing

Pull requests welcome! To develop:

```bash
git clone https://github.com/domdomegg/sup-cli
cd sup-cli
npm install
npm test
npm run build
```
