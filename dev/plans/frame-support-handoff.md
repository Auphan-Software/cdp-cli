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

## Remaining Work

### Easy (Medium Priority)
| Command | Work Needed |
|---------|-------------|
| `snapshot --frame` | Pass contextId to Runtime.evaluate |
| `wait-for --frame` in navigate | Evaluate selector check in frame context |

### Complex (Lower Priority)
| Command | Work Needed |
|---------|-------------|
| `click --frame` | Coordinate translation: iframe rect + element rect |
| `fill --frame` | Same as click - need iframe offset |
| `drag --frame` | Same as click |

**Coordinate Translation Challenge:**
Input events (mouse/touch) use viewport coordinates. When targeting elements inside iframes:
1. Find element in iframe context
2. Get element's rect (relative to iframe)
3. Get iframe's rect (relative to viewport)
4. Add offsets: `viewportX = iframeX + elementX`

### Implementation Pattern for Input Commands

```typescript
// In click command, if frame specified:
if (options.frame) {
  // 1. Get iframe element rect in top frame
  const iframeRect = await getIframeRect(ws, options.frame);

  // 2. Resolve frame context
  const contextId = await context.resolveFrameContext(ws, options.frame);

  // 3. Find element in frame and get its rect
  const elementRect = await findElementInFrame(ws, contextId, target);

  // 4. Translate coordinates
  const x = iframeRect.x + elementRect.x + elementRect.width / 2;
  const y = iframeRect.y + elementRect.y + elementRect.height / 2;

  // 5. Dispatch input event with translated coords
  await dispatchClick(ws, x, y);
}
```

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
