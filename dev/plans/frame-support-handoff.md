# Frame Support Implementation - Handoff

## Completed This Session

### P2 Navigate Wait Features ✅
- `--wait-for <selector>` - wait for CSS selector after navigation
- `--wait-for-text <text>` - wait for text in page body
- `--wait-for-idle` - wait for network idle + document ready
- `--timeout <ms>` - configurable timeout (default 10000ms)

All tested on mako2 SPA.

### Eval Frame Targeting ✅
- `--frame <selector>` - target iframe by CSS selector (e.g. `--frame "#myframe"`)
- `--frame <index>` - target iframe by index (1 = first iframe)

Example:
```bash
cdp-cli eval "document.querySelector('select')?.id" "PAGE" --frame "#page-engine2-iframe"
# Returns: "report_id" (element inside iframe)
```

### Core Infrastructure in context.ts ✅
- `getFrameTree(ws)` - returns all frames in page hierarchy
- `getExecutionContexts(ws)` - collects execution contexts per frame
- `resolveFrameContext(ws, frameSpec)` - resolves selector/index to contextId

## Session 2 Completed

### Snapshot Frame Support ✅
- `--frame <selector>` - target iframe by CSS selector
- `--frame <index>` - target iframe by index (1 = first iframe)

### Navigate Wait Frame Support ✅
- `--wait-for-frame <spec>` - target iframe for `--wait-for` and `--wait-for-text` checks

Example:
```bash
cdp-cli navigate "http://example.com" PAGE --wait-for "#content" --wait-for-frame "#myframe"
```

### Code Refactoring ✅
- Extracted `getAxSnapshotScript()` and `formatAxElements()` helpers in debug.ts
- Reduced code duplication for ax snapshot logic

## Session 3 Completed

### Input Commands Frame Support ✅
All input commands now support `--frame` for targeting elements inside iframes:
- `click --frame <spec>` - click elements in iframe
- `fill --frame <spec>` - fill inputs in iframe
- `drag --frame <spec>` - drag within iframe (applies to both source and destination)

**Implementation:**
1. Get iframe rect from top frame for coordinate offset
2. Resolve frame execution context
3. Find element in frame using Runtime.evaluate with contextId
4. Add iframe offset to element coordinates for viewport translation

**Helper functions added in input.ts:**
- `getIframeRect(context, ws, frameSpec)` - get iframe bounding rect
- `resolveClickCandidatesInFrame(context, ws, target, contextId)` - find elements in frame

## All Frame Support Complete ✅

| Command | Status |
|---------|--------|
| `eval --frame` | ✅ |
| `snapshot --frame` | ✅ |
| `navigate --wait-for-frame` | ✅ |
| `click --frame` | ✅ |
| `fill --frame` | ✅ |
| `drag --frame` | ✅ |

## Files Modified

- `src/context.ts` - Frame tree/context resolution methods
- `src/commands/pages.ts` - Navigate wait options
- `src/commands/debug.ts` - Eval --frame support
- `src/index.ts` - CLI options for navigate and eval

## Testing Notes

- Wait features work on top-level document only (not inside iframes)
- For iframe content, use `--wait-for-text` or `--wait-for-idle`
- `--frame` requires direct WebSocket (daemon doesn't support contextId)
- When daemon is running, eval without --frame uses daemon; with --frame uses direct WS
