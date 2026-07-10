# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Releases before
`0.6.0` are recorded in the [GitHub Releases](https://github.com/conorbronsdon/substack-mcp/releases)
and the git tag history (`v0.1.0`–`v0.5.0`).

## [Unreleased]

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
