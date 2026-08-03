# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before
`0.6.0` are recorded in the [GitHub Releases](https://github.com/conorbronsdon/substack-mcp/releases)
and the git tag history (`v0.1.0`–`v0.5.0`).

## [Unreleased]

## [0.6.1] - 2026-08-03

### Fixed
- `get_post_analytics` no longer fails on every call. It paged the published
  feed with a hardcoded `pageSize = 100`, and Substack's `post_management`
  endpoints reject any `limit` above 50 — so the very first page request 400'd
  regardless of which post ID was passed. Page size is now the new exported
  `MAX_PAGE_SIZE` (50) and the page bound rises from 5 to 10, preserving the
  documented 500-post scan depth. Pages are still awaited one at a time, so the
  worst case is 10 sequential requests, and only when the ID is absent from the
  feed entirely. (#28)
- `list_published_posts`, `list_drafts`, and `list_scheduled_posts` clamp
  `limit` to 50 rather than 100. The default of 25 kept this latent, but any
  caller passing a larger value got a 400 from Substack. Over-cap values are
  still clamped rather than rejected, so existing callers passing 100 keep
  working. (#28)

### Changed
- The three `limit` parameters now advertise `1-50` instead of `1-100`. The tool
  description is what tells a model which values are legal, so the wrong number
  there was actively producing the failing calls. (#28)
- `get_post_analytics` derives the "500 most recent posts" figure in its
  description and its not-found note from `MAX_PAGE_SIZE * ANALYTICS_MAX_PAGES`
  instead of restating the literal, so it cannot rot when either changes. (#28)

## [0.6.0] - 2026-07-10

### Added
- `upload_image` accepts a local file path via `image_path` (mutually exclusive
  with `image_base64`). The file is read and encoded to a data URI internally,
  with the MIME type inferred from the extension — the agent no longer has to
  read and pass raw image bytes. (#20, #21)

### Fixed
- Markdown image conversion now nests an `image2` node inside `captionedImage`,
  matching Substack's editor schema, instead of emitting a flat `captionedImage`
  node. The flat node was accepted by the drafts API but crashed Substack's
  editor on render. Applies to `create_draft`, `update_draft`, and
  `create_note`. (#21)
- The image `_WxH_` dimension suffix is now only parsed on Substack CDN URLs, so
  a hand-embedded external image with an aspect-ratio filename (e.g.
  `hero_16x9.jpg`) no longer gets bogus 16×9-pixel dimensions. (#21)
