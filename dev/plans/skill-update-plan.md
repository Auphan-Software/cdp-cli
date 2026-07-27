# cdp-cli Skill Update Plan

## Overview

After implementing the cdp-cli tooling improvements (see `navAuto-integration.md`), the Claude Code skill documentation needs updates to leverage the new capabilities.

**Skill Location:** `auphan-claude-code-plugins/developer-tools/*/skills/cdp-cli/`

## Current Skill Structure

```
skills/cdp-cli/
├── index.md           # Main skill documentation
├── scripts/
│   └── launch.ps1     # Chrome launcher script
└── profiles/
    └── chrome-debug/  # Chrome debug profile
```

## Documentation Updates

### 1. Update `index.md` - New Flags Section

Add documentation for new flags:

```markdown
### Async Evaluation

For async/await code, use the `--async` flag. The last expression is auto-returned (matching DevTools console behavior):

```bash
# Old way (manual IIFE wrapping)
cdp-cli eval "(async () => { return await fetch('/api'); })()" "PAGEID"

# New way - last expression auto-returned
cdp-cli eval --async "await fetch('/api')" "PAGEID"

# Multi-statement - last expression returned
cdp-cli eval --async "const data = await fetch('/api'); data.status" "PAGEID"
# Returns: 200

# Explicit return still works
cdp-cli eval --async "const data = await fetch('/api'); return data.json()" "PAGEID"
```

### File-Based Evaluation

For complex JavaScript, use `--file` (avoids shell escaping issues):

```bash
# Write JS to file - last expression auto-returned
cat > test.js << 'EOF'
const buttons = await top.navAuto.listButtons({limit: 5});
buttons.map(b => b.text)
EOF

# Execute with --async for await support
cdp-cli eval --file test.js --async "PAGEID"
# Returns: ["Button 1", "Button 2", ...]

# Without --async (sync code only)
cdp-cli eval --file query.js "PAGEID"
```

Note: `--file` uses the same auto-return behavior - last expression is returned.

### Wait-For Navigation

For SPAs, wait for specific elements:

```bash
cdp-cli navigate "http://app.com/#/page" "PAGEID" --wait-for ".page-loaded"
cdp-cli navigate "http://app.com/" "PAGEID" --wait-for-text "Welcome"
cdp-cli navigate "http://app.com/" "PAGEID" --wait-for-idle
```

### Health Check

Verify daemon and Chrome status:

```bash
cdp-cli status
```
```

### 2. Update `index.md` - navAuto Integration Pattern

Add new section for SPA automation:

```markdown
## SPA Automation with navAuto

For applications with built-in automation APIs (like mako2's `navAuto`), combine cdp-cli with eval:

### Pattern: navAuto Integration

```bash
# 1. Navigate to app
cdp-cli navigate "http://127.0.0.1/mako2/" "PAGEID" --wait-for-idle

# 2. Use navAuto for SPA navigation
cdp-cli eval --async "await top.navAuto.enterArea('99', 'FOH')" "PAGEID"

# 3. Click sequence
cdp-cli eval --async "await top.navAuto.clickSequence(['Counter Order'])" "PAGEID"

# 4. Debug - list buttons
cdp-cli eval --async "top.navAuto.listButtons({text: 'payment', limit: 5})" "PAGEID"

# 5. Screenshot result
cdp-cli screenshot "PAGEID" -o result.png --scale 0.5
```

### navAuto API Quick Reference

| Method | Description |
|--------|-------------|
| `enterArea(pin, area)` | Login and navigate (FOH, Management, etc.) |
| `clickSequence([...])` | Click buttons in sequence |
| `listButtons({filters})` | List interactive elements |
| `waitForElement(sel, ms)` | Wait for element |
| `fillForm({field: value})` | Fill form fields |
| `fakeDropdown(sel, opts)` | Interact with custom dropdowns |

### Example: Full Test Flow

```bash
# test-payment-flow.sh
PAGE=$(cdp-cli list-pages | jq -r '.[0].id')

cdp-cli navigate "http://127.0.0.1/mako2/" "$PAGE" --wait-for-idle

cdp-cli eval --async "await top.navAuto.enterArea('99', 'FOH')" "$PAGE"
cdp-cli eval --async "await top.navAuto.clickSequence(['Counter Order'])" "$PAGE"
cdp-cli screenshot "$PAGE" -o step1-invoice-list.png --scale 0.5

cdp-cli eval --async "await top.navAuto.clickSequence(['Close'])" "$PAGE"
cdp-cli screenshot "$PAGE" -o step2-payment.png --scale 0.5

cdp-cli eval --async "await top.navAuto.clickSequence(['UberEATS'])" "$PAGE"
cdp-cli screenshot "$PAGE" -o step3-confirm-dialog.png --scale 0.5
```
```

### 3. Update `index.md` - LLM Usage Patterns

Update the patterns section:

```markdown
## LLM Usage Patterns

### Pattern: SPA Testing (Recommended)

```bash
# 1. Verify connection
cdp-cli status

# 2. Launch if needed
scripts/launch.ps1

# 3. Navigate with wait
cdp-cli navigate "http://app.com/" "PAGEID" --wait-for-idle

# 4. Use app's automation API if available
cdp-cli eval --async "await app.automationApi.doSomething()" "PAGEID"

# 5. Fallback to direct interaction
cdp-cli click --text "Submit" "PAGEID"

# 6. Screenshot
cdp-cli screenshot "PAGEID" -o result.png --scale 0.5
```

### Pattern: Complex JS Evaluation

```bash
# For multi-line or complex JS, use file-based eval
cat > query.js << 'EOF'
const items = document.querySelectorAll('.item');
return Array.from(items).map(el => ({
  text: el.textContent,
  visible: el.offsetParent !== null
}));
EOF

cdp-cli eval --file query.js "PAGEID"
```

### Pattern: Debug Element Discovery

```bash
# If app has navAuto or similar
cdp-cli eval --async "top.navAuto.listButtons({text: 'save', limit: 10})" "PAGEID"

# Otherwise use snapshot
cdp-cli snapshot "PAGEID"
```
```

### 4. Update Minimum Version Requirement

In `scripts/launch.ps1`, update version check:

```powershell
$MIN_VERSION = "1.5.0"  # Updated from 1.4.0
```

## Implementation Checklist

- [ ] Wait for cdp-cli 1.5.0 release with new features
- [ ] Update `index.md` with new flags documentation
- [ ] Add navAuto integration section
- [ ] Update LLM usage patterns
- [ ] Update version check in launch.ps1
- [ ] Test all examples work
- [ ] Update CHANGELOG

## Rollout Plan

1. **Phase 1:** Release cdp-cli 1.5.0 with new features
2. **Phase 2:** Update skill documentation (this plan)
3. **Phase 3:** Update auphan-claude-code-plugins repo
4. **Phase 4:** Notify users of new capabilities

## Known Issue: Git Bash Interop

**Problem:** When calling cdp-cli from Git Bash, stdout is swallowed - commands appear to fail silently.

```bash
# From Git Bash - NO OUTPUT (looks like failure)
$ cdp-cli list-pages
$ echo $?
0

# From PowerShell - WORKS CORRECTLY
PS> cdp-cli list-pages
{"id":"ABC123","title":"My Page","url":"http://..."}
```

**Workaround:** Call cdp-cli via PowerShell wrapper:

```bash
# From Git Bash - use powershell -Command
$ powershell -Command "cdp-cli list-pages"
{"id":"ABC123","title":"My Page","url":"http://..."}

$ powershell -Command "cdp-cli eval --async 'await navAuto.enterArea(\"99\", \"FOH\")' 'PAGEID'"
```

**Root Cause:** Git Bash doesn't properly capture stdout from PowerShell scripts (.ps1 files). This is a shell interop issue, not a cdp-cli bug.

**Recommendation for skill docs:** Add note that LLM agents should prefer `powershell -Command "cdp-cli ..."` pattern when running from bash environments.

## Backward Compatibility

- Skill should work with cdp-cli >= 1.4.0 (old way still works)
- New features are additive, not breaking
- launch.ps1 warns if version < 1.5.0 but doesn't fail
