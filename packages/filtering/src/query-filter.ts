/**
 * Cursor-based list-query filtering, ported from platform-go's `database/filtering`. This is a
 * pagination + filter DTO with URL-param (de)serialization — **not** a SQL builder. Pagination is
 * forward-only by opaque cursor (the last row's id), never page/offset. The Go original carries no
 * `database` dependency and neither does this; it stays a universal package.
 *
 * Deliberate divergence from Go: the Go struct's JSON tags for the four time bounds are swapped
 * relative to their field names (`createdAfter` serializes as `"createdBefore"`, etc. — a bug). This
 * port uses the intuitive, consistent mapping (`createdAfter` ⇄ `"createdAfter"`), so params and
 * JSON round-trip cleanly.
 */

/** Hard ceiling on a page size; larger requested limits clamp down to this. */
export const MAX_QUERY_FILTER_LIMIT = 250;
/** Page size applied when none is requested (or a zero limit is requested). */
export const DEFAULT_QUERY_FILTER_LIMIT = 50;

/** Sort direction over the created-at ordering. */
export type SortDirection = "asc" | "desc";
export const SortAscending: SortDirection = "asc";
export const SortDescending: SortDirection = "desc";

/** The URL query-parameter keys {@link queryFilterFromSearchParams} and {@link toSearchParams} use. */
export const QueryKeys = {
  /** Opt-in flag to search the database rather than a search index. Carried for parity; not parsed. */
  useDatabase: "useDB",
  limit: "limit",
  cursor: "cursor",
  createdBefore: "createdBefore",
  createdAfter: "createdAfter",
  updatedBefore: "updatedBefore",
  updatedAfter: "updatedAfter",
  includeArchived: "includeArchived",
  sortBy: "sortBy",
} as const;

/**
 * A list-query filter. Every field is optional; an absent field means "no constraint". The
 * `limit` is the page size (Go's `MaxResponseSize`), clamped to {@link MAX_QUERY_FILTER_LIMIT}.
 */
export interface QueryFilter {
  /** Created-at sort direction. */
  sortBy?: SortDirection;
  /** Lower bound (exclusive of older rows) on `created_at`. */
  createdAfter?: Date;
  /** Upper bound on `created_at`. */
  createdBefore?: Date;
  /** Lower bound on `updated_at`. */
  updatedAfter?: Date;
  /** Upper bound on `updated_at`. */
  updatedBefore?: Date;
  /** Page size; clamped to `[0, MAX_QUERY_FILTER_LIMIT]`. */
  limit?: number;
  /** Whether archived rows are included. */
  includeArchived?: boolean;
  /** Opaque forward cursor: the id of the last row from the previous page. */
  cursor?: string;
}

/** Pagination metadata returned alongside a page of data. */
export interface Pagination {
  /** The filter that produced this page, or `undefined` when none was supplied. */
  appliedQueryFilter: QueryFilter | undefined;
  /** Cursor to pass as {@link QueryFilter.cursor} for the next page (empty when there is no next page). */
  cursor: string;
  /** The cursor that produced this page (empty for the first page). */
  previousCursor: string;
  /** Rows matching the filter on this page's query, before the limit. */
  filteredCount: number;
  /** Total rows in the set, ignoring the filter. */
  totalCount: number;
  /** The page size applied. */
  limit: number;
}

/** A page of data plus its {@link Pagination}. */
export interface QueryFilteredResult<T> extends Pagination {
  data: T[];
}

/** A fresh filter with the default page size and ascending sort, and no other constraints. */
export function defaultQueryFilter(): QueryFilter {
  return { limit: DEFAULT_QUERY_FILTER_LIMIT, sortBy: SortAscending };
}

function parseBool(raw: string): boolean | undefined {
  switch (raw.toLowerCase()) {
    case "1":
    case "t":
    case "true":
      return true;
    case "0":
    case "f":
    case "false":
      return false;
    default:
      return undefined;
  }
}

function parseDate(raw: string): Date | undefined {
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseLimit(raw: string): number | undefined {
  // Unsigned, like Go's ParseUint: reject anything non-integer or negative, then clamp the ceiling.
  if (!/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return undefined;
  return Math.min(value, MAX_QUERY_FILTER_LIMIT);
}

function parseSort(raw: string): SortDirection | undefined {
  const lowered = raw.toLowerCase();
  return lowered === SortAscending || lowered === SortDescending ? lowered : undefined;
}

/**
 * Overlays the recognized params from `params` onto `base`, returning a new filter. A missing or
 * unparseable param leaves the corresponding field as it was in `base` (mirrors Go's `FromParams`,
 * which mutates only the fields it can parse).
 */
export function queryFilterFromSearchParams(
  params: URLSearchParams,
  base: QueryFilter = {},
): QueryFilter {
  const filter: QueryFilter = { ...base };

  const cursor = params.get(QueryKeys.cursor);
  if (cursor !== null && cursor !== "") filter.cursor = cursor;

  const limit = params.get(QueryKeys.limit);
  if (limit !== null) {
    const parsed = parseLimit(limit);
    if (parsed !== undefined) filter.limit = parsed;
  }

  for (const [key, field] of [
    [QueryKeys.createdAfter, "createdAfter"],
    [QueryKeys.createdBefore, "createdBefore"],
    [QueryKeys.updatedAfter, "updatedAfter"],
    [QueryKeys.updatedBefore, "updatedBefore"],
  ] as const) {
    const raw = params.get(key);
    if (raw === null) continue;
    const date = parseDate(raw);
    if (date !== undefined) filter[field] = date;
  }

  const includeArchived = params.get(QueryKeys.includeArchived);
  if (includeArchived !== null) {
    const parsed = parseBool(includeArchived);
    if (parsed !== undefined) filter.includeArchived = parsed;
  }

  const sortBy = params.get(QueryKeys.sortBy);
  if (sortBy !== null) {
    const parsed = parseSort(sortBy);
    if (parsed !== undefined) filter.sortBy = parsed;
  }

  return filter;
}

function searchParamsOf(
  input: URLSearchParams | URL | Request | string,
): URLSearchParams {
  if (input instanceof URLSearchParams) return input;
  if (input instanceof URL) return input.searchParams;
  if (input instanceof Request) return new URL(input.url).searchParams;
  // A string may be a full URL or a bare query string ("?a=1" / "a=1").
  try {
    return new URL(input).searchParams;
  } catch {
    return new URLSearchParams(input);
  }
}

/**
 * Builds a filter from an incoming request, URL, query string, or `URLSearchParams`: starts from
 * {@link defaultQueryFilter}, overlays the params, then — mirroring Go's `ExtractQueryFilterFromRequest`
 * — resets a `limit` of `0` back to {@link DEFAULT_QUERY_FILTER_LIMIT} so an explicit `limit=0` yields a
 * usable page rather than an empty one.
 */
export function extractQueryFilter(
  input: URLSearchParams | URL | Request | string,
): QueryFilter {
  const filter = queryFilterFromSearchParams(searchParamsOf(input), defaultQueryFilter());
  if (filter.limit === 0) filter.limit = DEFAULT_QUERY_FILTER_LIMIT;
  return filter;
}

/**
 * Serializes a filter back to `URLSearchParams`, emitting one key per defined field. An undefined
 * filter serializes the {@link defaultQueryFilter} (mirrors Go's nil-receiver behavior).
 */
export function toSearchParams(filter?: QueryFilter): URLSearchParams {
  const source = filter ?? defaultQueryFilter();
  const params = new URLSearchParams();

  if (source.limit !== undefined) params.set(QueryKeys.limit, String(source.limit));
  if (source.cursor !== undefined) params.set(QueryKeys.cursor, source.cursor);
  if (source.createdAfter !== undefined) {
    params.set(QueryKeys.createdAfter, source.createdAfter.toISOString());
  }
  if (source.createdBefore !== undefined) {
    params.set(QueryKeys.createdBefore, source.createdBefore.toISOString());
  }
  if (source.updatedAfter !== undefined) {
    params.set(QueryKeys.updatedAfter, source.updatedAfter.toISOString());
  }
  if (source.updatedBefore !== undefined) {
    params.set(QueryKeys.updatedBefore, source.updatedBefore.toISOString());
  }
  if (source.includeArchived !== undefined) {
    params.set(QueryKeys.includeArchived, String(source.includeArchived));
  }
  if (source.sortBy !== undefined) params.set(QueryKeys.sortBy, source.sortBy);

  return params;
}

/** Seeds a {@link Pagination} from a filter, copying the cursor and limit it carries. */
export function toPagination(filter?: QueryFilter): Pagination {
  const source = filter ?? defaultQueryFilter();
  return {
    appliedQueryFilter: source,
    cursor: "",
    previousCursor: "",
    filteredCount: 0,
    totalCount: 0,
    limit: source.limit ?? DEFAULT_QUERY_FILTER_LIMIT,
  };
}

/**
 * Assembles a page of results with forward-cursor pagination. `idExtractor` yields the opaque
 * cursor for a row; the next-page `cursor` is the last row's id (empty when the page is empty), and
 * `previousCursor` echoes the input filter's cursor.
 */
export function newQueryFilteredResult<T>(
  data: T[],
  filteredCount: number,
  totalCount: number,
  idExtractor: (item: T) => string,
  filter?: QueryFilter,
): QueryFilteredResult<T> {
  const pagination = toPagination(filter);
  const last = data.at(-1);
  return {
    ...pagination,
    appliedQueryFilter: filter,
    filteredCount,
    totalCount,
    previousCursor: filter?.cursor ?? "",
    cursor: last === undefined ? "" : idExtractor(last),
    data,
  };
}
