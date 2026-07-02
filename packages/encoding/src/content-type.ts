/**
 * The content types this package can encode and decode. Modeled as a string-literal union of the
 * canonical MIME strings — the idiomatic replacement for platform-go's pointer-identity
 * `ContentType` type, which existed only to make `==` comparisons cheap.
 *
 * Emoji (platform-go's `application/emoji`) is intentionally absent: it round-trips through Go's
 * `gob` binary format and cannot interoperate with anything outside Go.
 */
export const ContentTypeJSON = "application/json";
export const ContentTypeXML = "application/xml";
export const ContentTypeTOML = "application/toml";
export const ContentTypeYAML = "application/yaml";

export type ContentType =
  | typeof ContentTypeJSON
  | typeof ContentTypeXML
  | typeof ContentTypeTOML
  | typeof ContentTypeYAML;

/** Every supported content type, in the same order as platform-go's `ContentTypes`. */
export const CONTENT_TYPES: readonly ContentType[] = [
  ContentTypeJSON,
  ContentTypeXML,
  ContentTypeTOML,
  ContentTypeYAML,
];

/** The fallback for unknown or absent content types — JSON, matching platform-go. */
export const DEFAULT_CONTENT_TYPE: ContentType = ContentTypeJSON;

/** The canonical header name carrying the content type. Fetch `Headers` match it case-insensitively. */
export const ContentTypeHeaderKey = "Content-Type";

/**
 * Maps a raw header value (or any string) onto a {@link ContentType}, defaulting to JSON for
 * anything unrecognized — the same lenient behavior as platform-go's `contentTypeFromString`.
 * Trims, lowercases, and drops any `;charset=…` parameter so real `Content-Type` headers match.
 */
export function contentTypeFromString(value: string | null | undefined): ContentType {
  const normalized = (value ?? "").split(";", 1)[0]?.trim().toLowerCase();
  switch (normalized) {
    case ContentTypeXML:
      return ContentTypeXML;
    case ContentTypeTOML:
      return ContentTypeTOML;
    case ContentTypeYAML:
      return ContentTypeYAML;
    case ContentTypeJSON:
    default:
      return ContentTypeJSON;
  }
}
