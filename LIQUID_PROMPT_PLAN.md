# Liquid Template Support - Prompt Plan

## Overview

Claude needs to understand when and how to use Liquid templates in Fluxx text elements. Liquid enables dynamic content that pulls data from the current form, related records, and linked models.

## When to Use Liquid

Claude should recognize these patterns as requests for Liquid:

| User Says | Means |
|-----------|-------|
| "Make a table showing all linked [records]" | Loop over relationship, render rows |
| "Show fields X-Y in a table" | Create table with field references |
| "Display the related [model] data" | Access relationship fields |
| "Show a summary of payments/reports/etc" | Loop + calculations |
| "Add conditional formatting based on status" | Liquid if/elsif for styling |
| "Calculate the total of X" | Assign + loop + plus filter |
| "Show different text based on [field]" | Conditional rendering |

**Key insight:** Any request involving:
- Multiple related records → needs loop
- Data from linked models → needs relationship access
- Calculated values → needs assign + filters
- Conditional display → needs if/elsif/else

## Fluxx Liquid Syntax

### Constraints (OLD Engine)
- No comments (`{% comment %}` not supported)
- No `{% liquid %}` tag
- No `{% render %}` or `{% include %}`
- Stick to: `if`, `elsif`, `else`, `for`, `assign`, `capture`
- Use `-%}` for whitespace control when needed

### Basic Field Access

```liquid
{{ model.field_name }}                    <!-- Current form field -->
{{ model.field_name | default: "N/A" }}   <!-- With fallback -->
{{ model.relationship.field_name }}        <!-- Linked model field -->
```

### Loops (Related Records)

```liquid
{% for item in model.rd_tab_relationship_name %}
  {{ item.field_name }}
{% endfor %}
```

Common relationship patterns:
- `model.rd_tab_request_transactions` - transactions
- `model.rd_tab_request_reports` - reports
- `model.rd_tab_dyn_model_N` - dynamic models (N = theme ID suffix)

### Conditionals

```liquid
{% if field == "value" %}
  ...
{% elsif field == "other" %}
  ...
{% else %}
  ...
{% endif %}

{% if field %}              <!-- truthy check -->
{% if field != null %}      <!-- null check -->
{% if field == true %}      <!-- boolean check -->
```

### Variables & Calculations

```liquid
{% assign total = 0 %}
{% for item in model.rd_tab_items %}
  {% assign total = total | plus: item.amount %}
{% endfor %}
{{ total }}

{% assign balance = model.budget | minus: total %}
{% assign ratio = spent | divided_by: budget | times: 100 %}
```

### Common Filters

| Filter | Purpose | Example |
|--------|---------|---------|
| `default:` | Fallback value | `{{ x \| default: "N/A" }}` |
| `format_date` | Format date | `{{ x \| format_date }}` |
| `currency_local` | Format currency | `{{ x \| currency_local }}` |
| `plus:` | Add | `{{ x \| plus: y }}` |
| `minus:` | Subtract | `{{ x \| minus: y }}` |
| `times:` | Multiply | `{{ x \| times: 100 }}` |
| `divided_by:` | Divide | `{{ x \| divided_by: y }}` |
| `percentage: N` | Format as % | `{{ x \| percentage: 2 }}` |
| `upcase` | Uppercase | `{{ x \| upcase }}` |
| `downcase` | Lowercase | `{{ x \| downcase }}` |
| `size` | Array length | `{{ items \| size }}` |

## Common Patterns

### Dynamic Table with Loop

```html
<table style="border-collapse:collapse;">
  <tr>
    <th style="border:1px solid #666;padding:8px;background:#444;color:#fff;">Column 1</th>
    <th style="border:1px solid #666;padding:8px;background:#444;color:#fff;">Column 2</th>
  </tr>
  {% for item in model.rd_tab_items %}
  <tr>
    <td style="border:1px solid #666;padding:8px;">{{ item.field_1 }}</td>
    <td style="border:1px solid #666;padding:8px;">{{ item.field_2 }}</td>
  </tr>
  {% endfor %}
</table>
```

### Conditional Row Styling

```liquid
{% if item.status == "approved" %}
  <td style="background-color:#90ee90;">Approved</td>
{% elsif item.status == "pending" %}
  <td style="background-color:#ffc107;">Pending</td>
{% elsif item.status == "rejected" %}
  <td style="background-color:#f08080;">Rejected</td>
{% else %}
  <td>{{ item.status }}</td>
{% endif %}
```

### Running Total Calculation

```liquid
{% assign total = 0 %}
{% for item in model.rd_tab_transactions %}
  {% if item.amount != null %}
    {% assign total = total | plus: item.amount -%}
  {% endif %}
{% endfor %}
<strong>Total:</strong> {{ total | currency_local }}
```

### Filtered Loop (Only Certain Records)

```liquid
{% for item in model.rd_tab_records %}
  {% if item.type == "SpecificType" %}
    <tr>
      <td>{{ item.name }}</td>
    </tr>
  {% endif %}
{% endfor %}
```

### Modal Edit Links

```html
<a href="/machine_models/{{ item.id }}/edit"
   class="to-modal"
   data-on-success="refreshCaller,close"
   title="Edit">
  {{ item.name }}
</a>
```

### Empty State Check

```liquid
{% assign count = 0 %}
{% for item in model.rd_tab_items %}
  {% assign count = count | plus: 1 %}
{% endfor %}

{% if count == 0 %}
  <div style="padding:10px;background:#ffc;border:1px solid #faa;color:#a00;">
    <strong>No items found.</strong>
  </div>
{% else %}
  <!-- render table -->
{% endif %}
```

## System Prompt Addition

```
## Liquid Templates

For dynamic content in text elements, use Liquid syntax:

**When to use Liquid:**
- User asks to "show" or "display" related records in a table
- User wants calculations (totals, balances, ratios)
- User wants conditional formatting based on field values
- User references "linked" or "related" data

**Basic syntax:**
- Field access: {{ model.field_name }}
- Related model: {{ model.relationship.field_name }}
- Loop: {% for item in model.rd_tab_name %}...{% endfor %}
- Conditional: {% if x == "y" %}...{% elsif %}...{% else %}...{% endif %}
- Variable: {% assign total = 0 %}
- Filters: | default: "N/A", | format_date, | currency_local, | plus:, | minus:

**Important:**
- Old Liquid engine - no comments, no fancy features
- Use inline styles for tables (border-collapse, padding, etc.)
- For edit links: <a href="/machine_models/{{ item.id }}/edit" class="to-modal">
- Always provide fallbacks: {{ field | default: "N/A" }}
```

## Implementation Plan

### Phase 1: Add Liquid Awareness to System Prompt
1. Add "Liquid Templates" section to system prompt
2. Include when-to-use triggers
3. Document basic syntax and common patterns

### Phase 2: Add Liquid Examples to Context (Optional)
- Could add a `get_liquid_examples` tool that returns patterns
- Or include condensed examples in system prompt

### Phase 3: Test Cases
1. "Add a table showing all linked transactions"
2. "Show the total amount paid"
3. "Display compliance requirements with color-coded status"
4. "Create a summary table of fields 3.1 through 3.5"
5. "Show risks shared with Fund Panel"

## Token Considerations

Adding Liquid guidance to the system prompt will increase base tokens by ~500-800. This is acceptable because:
- Liquid is a core Fluxx capability
- Without guidance, Claude would fail these requests entirely
- The patterns are reusable across many operations

## Standard Relationships (Claude knows these)

Claude should recognize these standard relationship names and use them directly:

| User Says | Relationship Field | Model Type |
|-----------|-------------------|------------|
| "reports", "linked reports" | `model.rd_tab_request_reports` | RequestReport |
| "reviews", "linked reviews" | `model.rd_tab_request_reviews` | RequestReview |
| "transactions", "payments" | `model.rd_tab_request_transactions` | RequestTransaction |
| "organization", "grantee org" | `model.program_organization` | Organization |
| "users", "grantee users" | `model.grantee_user_ids` | User |

## Workflow for Building Liquid Tables

### Known Relationship (e.g., "show a table of reports")
1. Claude recognizes "reports" → `model.rd_tab_request_reports`
2. Claude asks: "What fields from the reports should I include? (e.g., state, due_at, total_expenses)"
3. User provides field names
4. Claude builds the Liquid table

### Unknown Relationship (e.g., "show a table of compliance records")
1. Claude doesn't recognize "compliance records" as a standard relationship
2. Claude asks: "What is the relationship field name for compliance records? (e.g., rd_tab_dyn_model_4)"
3. User provides: `rd_tab_dyn_model_4`
4. Claude asks: "What fields should I include from those records?"
5. User provides field names
6. Claude builds the Liquid table

### Example Conversation Flow

**User:** "Add a table showing all linked reports"

**Claude:** "I'll create a Liquid table for reports using `model.rd_tab_request_reports`. What fields from the reports should I display? For example: state, due_at, total_expenses, progress_rating"

**User:** "state, due_at, and total_expenses"

**Claude:** *Creates text element with Liquid table*

---

**User:** "Add a table showing compliance requirements"

**Claude:** "I don't have a standard relationship for 'compliance requirements'. What is the relationship field name? (It will look something like `rd_tab_dyn_model_N` or similar)"

**User:** "rd_tab_dyn_model_4"

**Claude:** "Got it. What fields from the compliance records should I include in the table?"

**User:** "evidence, target_date, condition_completed, state"

**Claude:** *Creates text element with Liquid table*

## System Prompt Addition (Updated)

```
## Liquid Templates

For dynamic content in text elements, use Liquid syntax.

**When to use Liquid:**
- User asks to "show" or "display" related records in a table
- User wants calculations (totals, balances, ratios)
- User wants conditional formatting based on field values
- User references "linked" or "related" data

**Standard relationships (use directly):**
- Reports: model.rd_tab_request_reports
- Reviews: model.rd_tab_request_reviews
- Transactions: model.rd_tab_request_transactions
- Organization: model.program_organization
- Users: model.grantee_user_ids

**For standard relationships:** Ask user for field names on the related model.
**For unknown relationships:** Ask user for BOTH the relationship field name AND the field names.

**Basic syntax:**
- Field: {{ model.field_name }}
- Loop: {% for item in model.rd_tab_name %}...{% endfor %}
- Conditional: {% if x == "y" %}...{% endif %}
- Variable: {% assign total = 0 %}
- Filters: | default: "N/A", | format_date, | currency_local, | plus:, | minus:

**Table pattern:**
<table style="border-collapse:collapse;">
  <tr><th style="border:1px solid #666;padding:8px;background:#444;color:#fff;">Header</th></tr>
  {% for item in model.rd_tab_name %}
  <tr><td style="border:1px solid #666;padding:8px;">{{ item.field | default: "N/A" }}</td></tr>
  {% endfor %}
</table>

**Important:**
- Old Liquid engine - no comments, stick to if/for/assign
- Always use inline styles for tables
- Always provide fallbacks: {{ field | default: "N/A" }}
```

## Validation (Future)

Could add basic validation in fluxx-bridge.js:
- Check for balanced `{% %}` and `{{ }}` tags
- Warn if relationship field doesn't exist in export
- Currently: No validation - Fluxx will error on bad syntax

## Conclusion

Liquid support requires:
1. System prompt update with syntax guide and standard relationships
2. Claude asking for field names when building tables
3. Claude asking for relationship field name when it's not a standard one
4. No code changes needed - Liquid goes in text element `content`

The key insight is teaching Claude WHEN to use Liquid and HOW to gather the information it needs (field names) from the user.
