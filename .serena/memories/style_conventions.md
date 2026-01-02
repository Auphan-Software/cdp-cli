# Code Style & Conventions

## TypeScript Configuration
- Strict mode enabled
- ES2020 target with NodeNext module resolution
- Source maps and declaration files generated

## Naming Conventions
- **Files**: kebab-case (e.g., `circular-buffer.ts`, `make-executable.mjs`)
- **CLI Commands**: dash-separated (e.g., `list-pages`, `new-page`, `resize-window`)
- **Internal Symbols**: camelCase (e.g., `outputLine`, `sendCommand`)
- **Classes**: PascalCase (e.g., `CDPContext`, `CircularBuffer`)
- **Interfaces**: PascalCase (e.g., `Page`, `ConsoleMessage`, `NetworkRequest`)

## Code Patterns
- Use named exports (not default exports)
- Two-space indentation
- Route all NDJSON formatting through `src/output.ts`
- Main CDP logic in `CDPContext` class (`src/context.ts`)
- Command handlers in `src/commands/` directory

## Output Formatting
All CLI output uses NDJSON via these functions from `output.ts`:
- `outputLine(obj)` - Single JSON line
- `outputLines(arr)` - Multiple JSON lines
- `outputError(message, code?)` - Error with `error: true`
- `outputSuccess(message, extras?)` - Success with `success: true`
- `outputRaw(str)` - Non-JSON output (rare)

## Error Handling
- Throw errors early
- No fallbacks in pre-production
- Errors output as NDJSON: `{"error":true,"message":"...","code":"..."}`
