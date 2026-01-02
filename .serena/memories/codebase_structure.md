# Codebase Structure

## Directory Layout
```
cdp-cli/
├── src/                    # TypeScript sources
│   ├── index.ts           # CLI entry point (yargs setup)
│   ├── context.ts         # CDPContext class - CDP session management
│   ├── output.ts          # NDJSON output formatting
│   ├── validation.ts      # Input validation utilities
│   ├── commands/          # CLI command handlers
│   │   ├── pages.ts       # list-pages, new-page, navigate, close-page, resize-window
│   │   ├── debug.ts       # screenshot, eval, snapshot, list-console
│   │   ├── network.ts     # list-network
│   │   ├── input.ts       # click, fill, press-key, drag
│   │   ├── daemon.ts      # daemon start/stop/status
│   │   └── logs.ts        # logs console/network/clear, logs-detail
│   └── daemon/            # Background daemon implementation
│       ├── index.ts       # Main daemon exports
│       ├── daemon.ts      # Daemon server logic
│       ├── daemon-entry.ts # Daemon process entry point
│       ├── client.ts      # Daemon client for CLI
│       ├── page-session.ts # Per-page log session
│       ├── circular-buffer.ts # Log buffer implementation
│       └── exec.ts        # Command execution via daemon
├── tests/                  # Test suite
│   ├── setup.ts           # Test environment setup
│   ├── helpers.ts         # Test utilities
│   ├── fixtures/          # CDP response fixtures
│   ├── mocks/             # WebSocket, fetch, daemon mocks
│   └── unit/              # Unit tests
│       ├── commands/      # Command-specific tests
│       └── daemon/        # Daemon-specific tests
├── scripts/               # Build utilities
├── build/                 # Compiled output (gitignored)
└── bundle/                # Single-file bundles
```

## Key Files
- `src/context.ts`: `CDPContext` class - core CDP communication
- `src/output.ts`: All NDJSON formatting functions
- `src/index.ts`: yargs CLI setup and command routing
- `src/daemon/daemon.ts`: Background process for log capture

## Command → File Mapping
| Command | Handler File |
|---------|--------------|
| list-pages, new-page, navigate, close-page, resize-window | commands/pages.ts |
| screenshot, eval, snapshot, list-console | commands/debug.ts |
| list-network | commands/network.ts |
| click, fill, press-key, drag | commands/input.ts |
| daemon start/stop/status | commands/daemon.ts |
| logs console/network/clear, logs-detail | commands/logs.ts |
