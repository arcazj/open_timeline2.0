# Filters and Search

Both providers apply one query contract to the complete selected data source. Filters determine the base set. Search produces a matching subset without deleting context from the main timeline. Density uses the base set, not only matches or a vertical page. The overview shows matches when search is active; the table explicitly chooses context or findings.

The Filters dialog includes a nested condition editor and Any term, All terms, or Exact phrase search. Search fields and case sensitivity are explicit. These controls are temporary query settings; saved-filter catalog CRUD and custom-schema field registration are not implemented in this increment.

## Structured Expressions

```json
{
  "filters": {
    "kind": "all",
    "sourceId": "all",
    "expression": {
      "version": 1,
      "root": {
        "op": "and",
        "args": [
          { "op": "eq", "field": "/sourceId", "value": "operations" },
          { "op": "gte", "field": "/order", "value": 10 },
          { "op": "contains", "field": "/tags", "value": "sample" }
        ]
      }
    }
  },
  "search": "Generic Nominal",
  "searchMode": "all",
  "searchCaseSensitive": false,
  "searchFields": ["/title", "/data/description", "/data/status"]
}
```

Supported predicates: `eq`, `ne`, `lt`, `lte`, `gt`, `gte`, `in`, `contains`, `exists`, `overlaps`; groups: `and`, `or`, `not`. `in` uses a `values` array, `exists` a boolean `value`, `not` one `arg`, and `overlaps` a positive half-open interval with offset-timestamp `from` and `to`. Group `args` arrays contain 1-100 children. Whole expressions are limited to 100 nodes and eight levels. Lists contain 1-100 typed values.

The shared field/type registry is `shared/fixtures/filter-fields.json`. Text comparisons normalize NFC. Ordered text uses Unicode codepoint ordering; numbers are finite and never coerced from text. Dates require explicit offsets. Text arrays support exact-member `contains` and `exists`; scalar text supports substring `contains`. Case-insensitive containment uses the shared Unicode casefold table.

Missing values produce unknown for comparisons; `not unknown` remains unknown, and only true predicates select records. Null is present for `exists`, comparable explicitly with equality/inequality, and unknown for ordered comparisons. Boolean groups use three-valued logic. An incompatible present value is an error, not a silent nonmatch.

## Search

Search is limited to 512 codepoints and 20 terms. Any/All modes split on unquoted whitespace or semicolons. Double quotes group a term; quote and backslash are the only escape sequences. Exact phrase treats the decoded, trimmed input as one phrase. An individual phrase must occur inside one selected scalar field, never across concatenated field boundaries. All terms may match different fields on the same record.

Search fields must be 1-16 unique registered scalar pointers. Empty search means no active search projection. Invalid input returns `invalid_search` or `invalid_filter` with status 422; the UI retains an invalid draft for correction. There is no regular-expression execution, arbitrary JavaScript, HTML rendering or dynamic property evaluation.

## Stable Views

Filter/search changes create a new immutable query snapshot. Vertical page changes reuse that query, map and global allocation. Table sorting/pagination uses the same query but an independent record ordering; changes arriving on the server cannot silently reorder a pinned page. Refresh explicitly admits new server data. Local and server results are compared through real HTTP tests, including null/missing, escapes, Unicode, overlapping sessions, complete table traversal and density invariance.
