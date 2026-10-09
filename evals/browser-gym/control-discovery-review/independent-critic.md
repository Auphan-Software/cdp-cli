# Independent engineering critic: control discovery

Read-only source and retained-trace review; no runtime edits. Parent verified and consolidated the findings below.

- Ten observations delivered 438 nodes. Repeated source prefixes cost 7,884 bytes; 426 weak-quality declarations cost 5,112 bytes. Context costs only 799 bytes. Preserve privacy hashes and useful state/context rather than optimizing tiny fields first.
- Equal-entropy base64url references plus an explicit weak default round-trip all records and reduce delivered observation JSON by 15.15%. Propagate representation metadata through the MCP receipt. Never remove per-reference namespaces: old references combined with new sources could otherwise bind shifted ordinals.
- The native trace uses screenshots and coordinates rather than semantic enumeration. Repeated visible persistent controls are a presentation cost; task pruning currently protects visible actions. Scoped presentation must preserve canonical capture, warnings, focus, values, and coverage disclosure. Existing container handles are too sparse to assume dialog scoping works.
- Opt-in follow-up controls on action results may remove model round trips while retaining lean default action receipts. Compare whole-task usage, not just individual result sizes.
- Existing CLI text-plus-scope targeting is a potential deterministic alternative to re-observing a known label. It is not safe to expose unchanged: `document.querySelector(within)` silently chooses the first scope, and top-document target promotion may escape its root. Require unique scopes and containment.
- Exact descendant text differs from accessible names; frame and shadow behavior differ too. Test duplicate/missing scopes, ancestor escape, hidden/disabled/occluded controls, ownership/source mismatches, unnamed targets, and uncertainty after dispatch. Do not expose fuzzy/regex/nth/force behavior in a minimal workflow path.
- Source-scoped key rejection remains an execution invariant. Defer cross-source identity carry-forward and coordinate APIs until separately justified.

The critic's initial native click count was corrected by primary deduplication to 9. No critic estimate is presented as a measured successful-task token saving.
