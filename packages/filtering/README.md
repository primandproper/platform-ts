# @primandproper/filtering

Universal cursor-based list-query filtering — a pagination + filter DTO with URL-param
(de)serialization. The TypeScript port of platform-go's `database/filtering`.

This is **not** a SQL builder. Pagination is forward-only by opaque cursor (the last row's id),
never page/offset. It carries no `database` dependency.

## Usage

```ts
import {
  extractQueryFilter,
  toSearchParams,
  newQueryFilteredResult,
} from "@primandproper/filtering";

// Parse an incoming request (or URL / query string / URLSearchParams).
const filter = extractQueryFilter(request); // { limit: 50, sortBy: "asc", ... }

// ...run your query with filter.limit / filter.cursor / filter.createdAfter ...

// Wrap the page; the next cursor is derived from the last row's id.
const page = newQueryFilteredResult(rows, rows.length, totalCount, (r) => r.id, filter);

// Serialize a filter back to query params (e.g. for a "next page" link).
const qs = toSearchParams({ ...filter, cursor: page.cursor }).toString();
```

## Notes

- `limit` (Go's `MaxResponseSize`) clamps to `[0, 250]`; the default page size is `50`. An explicit
  `limit=0` via `extractQueryFilter` resets to the default.
- **Deliberate divergence from Go:** the Go struct's JSON tags for the four time bounds are swapped
  relative to their field names. This port uses the intuitive, consistent mapping
  (`createdAfter` ⇄ `"createdAfter"`), so params and JSON round-trip cleanly.
