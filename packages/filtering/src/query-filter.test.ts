import { describe, expect, it } from "vitest";

import {
  DEFAULT_QUERY_FILTER_LIMIT,
  MAX_QUERY_FILTER_LIMIT,
  SortAscending,
  SortDescending,
  defaultQueryFilter,
  extractQueryFilter,
  newQueryFilteredResult,
  queryFilterFromSearchParams,
  toPagination,
  toSearchParams,
} from "./index.js";

describe("defaultQueryFilter", () => {
  it("defaults to the standard limit and ascending sort", () => {
    expect(defaultQueryFilter()).toStrictEqual({
      limit: DEFAULT_QUERY_FILTER_LIMIT,
      sortBy: SortAscending,
    });
  });
});

describe("queryFilterFromSearchParams", () => {
  it("parses every recognized field", () => {
    const params = new URLSearchParams({
      limit: "25",
      cursor: "abc",
      createdAfter: "2026-01-01T00:00:00.000Z",
      createdBefore: "2026-02-01T00:00:00.000Z",
      updatedAfter: "2026-03-01T00:00:00.000Z",
      updatedBefore: "2026-04-01T00:00:00.000Z",
      includeArchived: "true",
      sortBy: "desc",
    });

    expect(queryFilterFromSearchParams(params)).toStrictEqual({
      limit: 25,
      cursor: "abc",
      createdAfter: new Date("2026-01-01T00:00:00.000Z"),
      createdBefore: new Date("2026-02-01T00:00:00.000Z"),
      updatedAfter: new Date("2026-03-01T00:00:00.000Z"),
      updatedBefore: new Date("2026-04-01T00:00:00.000Z"),
      includeArchived: true,
      sortBy: SortDescending,
    });
  });

  it("leaves the base untouched for absent params", () => {
    const base = { limit: 10, sortBy: SortAscending } as const;
    expect(queryFilterFromSearchParams(new URLSearchParams(), base)).toStrictEqual(base);
  });

  it("ignores unparseable values rather than throwing", () => {
    const params = new URLSearchParams({
      limit: "-5",
      createdAfter: "not-a-date",
      includeArchived: "maybe",
      sortBy: "sideways",
    });
    expect(queryFilterFromSearchParams(params)).toStrictEqual({});
  });

  it("clamps the limit to the maximum", () => {
    const params = new URLSearchParams({ limit: "100000" });
    expect(queryFilterFromSearchParams(params).limit).toBe(MAX_QUERY_FILTER_LIMIT);
  });

  it("treats an empty cursor as absent", () => {
    expect(
      queryFilterFromSearchParams(new URLSearchParams({ cursor: "" })).cursor,
    ).toBeUndefined();
  });
});

describe("extractQueryFilter", () => {
  it("starts from the defaults", () => {
    expect(extractQueryFilter(new URLSearchParams())).toStrictEqual(defaultQueryFilter());
  });

  it("resets an explicit limit of 0 to the default", () => {
    expect(extractQueryFilter(new URLSearchParams({ limit: "0" })).limit).toBe(
      DEFAULT_QUERY_FILTER_LIMIT,
    );
  });

  it("accepts a full URL", () => {
    expect(
      extractQueryFilter("https://example.com/things?limit=5&sortBy=desc"),
    ).toMatchObject({
      limit: 5,
      sortBy: SortDescending,
    });
  });

  it("accepts a bare query string", () => {
    expect(extractQueryFilter("limit=7").limit).toBe(7);
  });

  it("accepts a Request", () => {
    const request = new Request("https://example.com/x?cursor=zzz");
    expect(extractQueryFilter(request).cursor).toBe("zzz");
  });
});

describe("toSearchParams", () => {
  it("round-trips a populated filter", () => {
    const filter = {
      limit: 25,
      cursor: "abc",
      createdAfter: new Date("2026-01-01T00:00:00.000Z"),
      includeArchived: false,
      sortBy: SortDescending,
    };
    const reparsed = queryFilterFromSearchParams(toSearchParams(filter));
    expect(reparsed).toStrictEqual(filter);
  });

  it("serializes the default filter for an undefined input", () => {
    const params = toSearchParams();
    expect(params.get("limit")).toBe(String(DEFAULT_QUERY_FILTER_LIMIT));
    expect(params.get("sortBy")).toBe(SortAscending);
  });

  it("omits fields that are not set", () => {
    expect(toSearchParams({ limit: 5 }).has("cursor")).toBe(false);
  });
});

describe("toPagination", () => {
  it("carries the filter's limit", () => {
    expect(toPagination({ limit: 20 })).toMatchObject({
      limit: 20,
      cursor: "",
      previousCursor: "",
    });
  });

  it("falls back to the default limit", () => {
    expect(toPagination().limit).toBe(DEFAULT_QUERY_FILTER_LIMIT);
  });
});

describe("newQueryFilteredResult", () => {
  const id = (item: { id: string }): string => item.id;

  it("derives the next cursor from the last row", () => {
    const data = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const result = newQueryFilteredResult(data, 3, 99, id, { cursor: "prev", limit: 50 });

    expect(result.data).toBe(data);
    expect(result.cursor).toBe("c");
    expect(result.previousCursor).toBe("prev");
    expect(result.filteredCount).toBe(3);
    expect(result.totalCount).toBe(99);
  });

  it("yields an empty cursor for an empty page", () => {
    const result = newQueryFilteredResult<{ id: string }>([], 0, 0, id);
    expect(result.cursor).toBe("");
    expect(result.previousCursor).toBe("");
  });
});
