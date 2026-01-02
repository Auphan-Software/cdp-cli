# Suggested Commands

## Build & Development
```bash
npm run build        # Clean, compile TypeScript, mark CLI executable
npm start            # Build and run CLI against Chrome with remote debugging
npm run clean        # Remove build output
npm run bundle       # Build + create single-file bundles in bundle/
```

## Testing
```bash
npm test             # Run Vitest suite once
npm run test:watch   # Watch mode for development
npm run test:coverage # Generate c8 coverage report (maintain 80%+)
npm run test:ui      # Interactive Vitest UI
```

## Version Management
```bash
npm run version:patch  # Bump patch version
npm run version:minor  # Bump minor version
npm run version:major  # Bump major version
```

## CLI Usage (requires Chrome with --remote-debugging-port=9222)
```bash
node build/index.js list-pages
node build/index.js screenshot "example" --output test.png --scale 0.5
node build/index.js daemon start
node build/index.js logs console "example" --last 20
```

## Git (use glab CLI)
```bash
git status
git add .
git commit -m "Commit message"
git push
glab mr create       # Create merge request
```

## System Commands (Windows)
```bash
dir                  # List directory
type file.txt        # View file contents
del file.txt         # Delete file
move src dest        # Move file
copy src dest        # Copy file
```
