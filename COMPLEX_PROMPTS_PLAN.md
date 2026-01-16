# Complex Operations Architecture Plan

## The Problem

Users can ask for arbitrarily complex transformations:
- "Duplicate section 3 with new field names"
- "Merge sections 4 and 5"
- "Reorganize this section to match section 2's structure"
- "Convert all text elements to fields"
- "Create a year-over-year comparison layout"
- ...infinite possibilities

Current architecture uses **predefined operation types** (edit, add, delete, move, bulk_replace). This is:
- ✅ Predictable and low-token
- ❌ Cannot handle creative/complex requests
- ❌ Requires adding new operation types for each new pattern (doesn't scale)

## Root Cause Analysis

The fundamental issue: **Claude lacks visibility into nested structures**.

Current tools only provide:
- `list_sections` → TOC groups with child counts
- `get_section_contents` → UIDs and previews of direct children
- `get_element_details` → Individual element properties (max 10)

For complex operations, Claude needs to:
1. See the FULL hierarchical structure of a subtree
2. Transform that structure (rename, duplicate, reorganize)
3. Output the result

Currently Claude cannot do step 1 without many iterations of `get_element_details`, which:
- Hits the 10-element limit
- Causes loop/iteration behavior
- Uses excessive tokens

## Proposed Solution: Subtree Operations

Add two new capabilities that work together:

### 1. New Tool: `get_subtree`

```javascript
{
  name: "get_subtree",
  description: "Get complete JSON structure of an element and ALL nested children. Use for complex operations requiring full structural knowledge (duplicating, restructuring, transforming sections).",
  input_schema: {
    type: "object",
    properties: {
      uid: { type: "string", description: "UID of the element to get" }
    },
    required: ["uid"]
  }
}
```

**Returns:** Complete JSON of the element including all nested `elements` arrays.

**Why this works:**
- Gives Claude full visibility in ONE tool call
- No iteration needed
- Token cost is proportional to subtree size (fair tradeoff)

### 2. New Operation: `replace_subtree`

```json
{
  "type": "replace_subtree",
  "target_uid": "...",
  "position": "replace|after|before",
  "structure": { /* complete JSON for new/modified subtree */ }
}
```

**Why this works:**
- Claude has full creative freedom
- Can duplicate, merge, reorganize, transform - anything
- Single operation, no matter how complex
- Predictable application (just insert/replace JSON)

## Workflow for Complex Operations

**Before (broken):**
```
User: "Duplicate section 3 with _y2 suffix"
Claude: *calls get_section_contents*
Claude: *sees 29 children, tries to get details*
Claude: *hits limits, iterates, gives up*
Result: 0 operations
```

**After (working):**
```
User: "Duplicate section 3 with _y2 suffix"
Claude: *calls list_sections, finds section 3 UID*
Claude: *calls get_subtree for that UID*
Claude: *receives full JSON structure*
Claude: *transforms it: new UIDs, modified labels, _y2 suffix on fields*
Claude: *outputs replace_subtree with transformed structure*
Result: Complete duplicated section
```

## Implementation Details

### Backend: get_subtree tool

```javascript
function handleGetSubtree(uid, session) {
  const { exportData } = session;
  const elements = exportData?.records?.Stencil?.[0]?.json?.elements || [];

  function findElement(els, targetUid) {
    for (const el of els) {
      if (el.uid === targetUid) return el;
      if (el.elements) {
        const found = findElement(el.elements, targetUid);
        if (found) return found;
      }
    }
    return null;
  }

  const element = findElement(elements, uid);
  if (!element) return { error: "Element not found" };

  // Return deep copy to prevent mutation
  return { structure: JSON.parse(JSON.stringify(element)) };
}
```

### Frontend: replace_subtree operation

```javascript
} else if (op.type === 'replace_subtree') {
  const targetUid = op.target_uid;
  const newStructure = op.structure;

  // Generate new UIDs for all elements in the structure
  function regenerateUids(el) {
    el.uid = generateUid();
    if (el.elements) {
      el.elements.forEach(regenerateUids);
    }
    return el;
  }

  const structureWithNewUids = regenerateUids(JSON.parse(JSON.stringify(newStructure)));

  if (op.position === 'replace') {
    // Find and replace the target element
    replaceElement(elements, targetUid, structureWithNewUids);
  } else {
    // Insert before/after
    insertElement(elements, targetUid, structureWithNewUids, op.position);
  }
}
```

### System Prompt Addition

```
## Complex Operations
For complex transformations (duplicate, merge, restructure):
1. Use get_subtree to see full structure of target section/group
2. Transform the JSON as needed (new labels, field name suffixes, reorganization)
3. Output replace_subtree with the modified structure

replace_subtree: {"type":"replace_subtree","target_uid":"...","position":"after","structure":{...}}
- position: "replace" (overwrite), "after" (insert copy after), "before" (insert before)
- structure: Complete JSON including nested elements. Generate new UIDs for duplicates.
```

## Token Considerations

| Scenario | Current Cost | New Cost |
|----------|--------------|----------|
| Simple edit | ~500 tokens | ~500 tokens (unchanged) |
| Duplicate small section (5 elements) | FAILS | ~1500 tokens |
| Duplicate large section (30 elements) | FAILS | ~5000 tokens |

The tradeoff is fair: complex operations cost more tokens, simple operations stay cheap.

## Alternative Approaches Considered

### ❌ Adding specific operation types (duplicate, merge, etc.)
- Doesn't scale - infinite possible operations
- Still wouldn't handle "reorganize to match section X's structure"

### ❌ Direct full-document manipulation
- Full JSON is thousands of lines
- Would blow up every request's token count
- Hard to preview changes

### ❌ Multi-turn agent mode
- Multiple API calls per request
- Slow, expensive, unpredictable
- Poor user experience

### ❌ DSL/scripting language
- Security concerns
- Added complexity
- Learning curve for the AI

### ✅ Subtree operations (chosen)
- Minimal new concepts (one tool, one operation)
- Enables arbitrary complexity
- Token cost scales with operation complexity
- No security concerns
- Works within existing architecture

## Migration Path

1. **Phase 1:** Add `get_subtree` tool - no breaking changes, Claude can start using it
2. **Phase 2:** Add `replace_subtree` operation handler in frontend
3. **Phase 3:** Update system prompt with guidance for complex operations
4. **Phase 4:** Test with various complex scenarios

## Final Implementation

Two operations were implemented:

### clone_subtree (Recommended for duplication)
```json
{"type":"clone_subtree","source_uid":"...","position":"after","label_find":"Section 3","label_replace":"Section 3 (Year 2)","field_suffix":"_y2"}
```
- **Efficient**: Claude outputs small operation, frontend does the cloning
- **Best for**: Duplicating sections with label/field name changes

### replace_subtree (For full control)
```json
{"type":"replace_subtree","target_uid":"...","position":"after","structure":{...}}
```
- **Flexible**: Claude outputs complete transformed structure
- **Best for**: Complex restructuring where clone_subtree isn't sufficient
- **Note**: Can hit token limits with large structures

## Success Criteria

- [x] "Duplicate section X with suffix" works (clone_subtree)
- [ ] "Merge sections X and Y" works (replace_subtree)
- [ ] "Reorganize section X to match section Y" works (replace_subtree)
- [x] Simple operations still work and stay low-token
- [x] No new iteration/loop problems
- [x] Preview shows meaningful information for both operations

## Open Questions

1. **UID generation:** Should Claude generate new UIDs, or should the frontend always regenerate them?
   - Recommendation: Frontend always regenerates to ensure uniqueness

2. **Field backend names:** When duplicating fields, need to ensure unique backend names
   - Recommendation: Frontend appends suffix if `field_suffix` provided, or generates unique names

3. **Preview for replace_subtree:** How to show what changed?
   - Recommendation: Show "Replace/Insert section: [label]" with expandable diff or structure preview

4. **Size limits:** Should there be a max size for get_subtree responses?
   - Recommendation: Warn if subtree > 50 elements, but don't hard-limit

## Conclusion

The subtree approach gives Claude the **visibility** and **output capability** needed for arbitrary complex operations, while:
- Keeping simple operations simple
- Not requiring prediction of all possible operation types
- Maintaining reasonable token costs
- Working within the existing tool-based architecture

This is the minimal change that enables maximum flexibility.
