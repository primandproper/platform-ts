# @primandproper/search

## 0.1.0

### Minor Changes

- 19b79dc: add the generic `DocumentIndex<T>` surface — a faithful port of `platform-go/search/text`.
  Provides `index(id, value)` / `search(query): T[]` / `delete(id)` / `wipe()` over whole
  documents, with `noop`, `algolia`, and `elasticsearch` providers, an embedded circuit breaker,
  injected observability, and an async `provideDocumentIndex<T>(indexName, config?, deps?)`
  factory (defaults to `noop`). Also ports the `IndexRequest` type and the `QUERY_KEY_SEARCH`
  constant. The existing `TextIndex`/`VectorIndex` surface is unchanged. The async indexing
  scheduler is deferred to a follow-up.
