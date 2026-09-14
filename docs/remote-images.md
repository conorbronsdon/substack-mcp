# Remote image URLs

`upload_image` accepts exactly one of `image_path`, `image_base64` or
`image_url`. With `image_url`, the server downloads the image and then uploads
it through the same Substack endpoint as the other two. The result is the same:
a hosted image URL that anyone with the link can fetch.

```json
{ "image_url": "https://images.example.com/chart.png" }
```

## What is refused

The download is a plain request made by the server, separate from the Substack
client. It sends no Substack cookies, session token, `Authorization` or
`Referer` header.

| Rule | Error `code` |
| --- | --- |
| Not an absolute `https` URL, contains credentials, or uses a non-default port | `invalid_url` |
| Resolves to or names a loopback, private, carrier-grade NAT, link-local (including `169.254.169.254`), multicast, documentation or other reserved address | `blocked_destination` |
| Host does not resolve | `dns_failed` |
| More than 3 redirects, or a redirect without `Location` | `too_many_redirects`, `http_status` |
| Any status other than 200 | `http_status` |
| Compressed or otherwise encoded body | `unsupported_encoding` |
| Declared or streamed size above 5 MB | `too_large` |
| Whole download, including redirects, takes longer than 15 seconds | `timeout` |
| Bytes are not PNG, JPEG, GIF, WebP or AVIF (SVG and HEIC included) | `unsupported_type` |
| `Content-Type` missing or different from the detected format | `type_mismatch` |
| Connection failed or ended early | `network` |

A refused download returns `isError: true` with
`{ "code", "message", "upload_attempts": 0 }`, and nothing is uploaded.

## Address checks

IPv4 addresses must be outside the special-purpose ranges listed above. IPv6
addresses must be global unicast (`2000::/3`). The server also refuses 6to4,
Teredo, NAT64 and documentation prefixes, which can embed IPv4 destinations.
IPv4-mapped forms such as `::ffff:169.254.169.254`, unique-local addresses such
as `fd00:ec2::254`, and addresses with a zone ID are refused.

The check happens when each connection is made, including after every
redirect. The server does not look the host up in advance and connect later, so
DNS rebinding can't swap in a private address between check and connection. If
a host resolves to several addresses and any one is refused, the whole request
is refused. Literal IP addresses in a URL or `Location` header are checked
before connecting.

Proxy environment variables are not used for this download.

## Deployments

The stdio and self-hosted HTTP servers include remote downloads. The Cloudflare
Worker shares the tool list but not the Node network stack these checks depend
on. There, `image_url` returns `remote_image_unavailable`; use `image_path` or
`image_base64` instead.

Local file and data URI uploads are unchanged: `image_path` still infers the
type from the file extension. The byte-signature and address checks above apply
only to `image_url`.
