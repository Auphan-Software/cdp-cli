# CDP-CLI Project Overview

## Purpose
CLI for Chrome DevTools Protocol (CDP), optimized for LLM agents with NDJSON output format. Provides CLI access to all Chrome DevTools Protocol features for browser automation, debugging, and network inspection.

## Tech Stack
- **Language**: TypeScript (strict mode, ES2020 target)
- **Module System**: NodeNext (ESM)
- **Runtime**: Node.js 18+
- **CLI Framework**: yargs v18
- **WebSocket**: ws v8 (for CDP communication)
- **HTTP Client**: undici v6
- **Image Processing**: sharp v0.34
- **Testing**: Vitest v4 with c8 coverage
- **Build**: tsc + esbuild for bundling

## Output Format
All list commands output **NDJSON** (newline-delimited JSON) - one complete JSON object per line.

## Key Features
- Page management (list, create, navigate, close, resize)
- Background daemon for automatic log capture
- Console and network log querying
- Screenshots with scaling
- Input automation (click, fill, press-key, drag)
- JavaScript evaluation
- Accessibility snapshots

## Dependencies
- `ws`: WebSocket for CDP communication
- `yargs`: CLI argument parsing
- `undici`: HTTP requests to Chrome's REST API
- `sharp`: Image resizing for screenshots
