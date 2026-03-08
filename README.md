# substack-mcp

An MCP server for Substack that lets AI assistants read your publication data and manage drafts.

**Safe by design:** This server can create and edit drafts but cannot publish or delete posts. You always review and publish manually through Substack's editor.

## Tools

### Read

| Tool | Description |
|------|-------------|
| `get_subscriber_count` | Get your publication's current subscriber count |
| `list_published_posts` | List published posts with pagination |
| `list_drafts` | List draft posts |
| `get_post` | Get full content of a published post by ID |
| `get_draft` | Get full content of a draft by ID |

### Write

| Tool | Description |
|------|-------------|
| `create_draft` | Create a new draft from markdown |
| `update_draft` | Update an existing draft (unpublished only) |
| `upload_image` | Upload an image to Substack's CDN |

### Intentionally excluded

- **Publish** — Publishing should be a deliberate human action
- **Delete** — Too destructive for an AI tool
- **Schedule** — Use Substack's editor for scheduling

## Setup

### 1. Get your credentials

Open your Substack in a browser, then:

1. **Session token:** DevTools → Application → Cookies → copy the value of `substack.sid`
2. **User ID:** DevTools → Console → run `document.cookie.match(/substack.uid=(\d+)/)?.[1]` or check any API response in the Network tab for your user ID
3. **Publication URL:** Your Substack URL (e.g., `https://yourblog.substack.com`)

### 2. Configure your MCP client

#### Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "substack": {
      "command": "npx",
      "args": ["-y", "@conorbronsdon/substack-mcp"],
      "env": {
        "SUBSTACK_PUBLICATION_URL": "https://yourblog.substack.com",
        "SUBSTACK_SESSION_TOKEN": "your-session-token",
        "SUBSTACK_USER_ID": "your-user-id"
      }
    }
  }
}
```

#### Claude Code

Add to your `.mcp.json`:

```json
{
  "mcpServers": {
    "substack": {
      "command": "npx",
      "args": ["-y", "@conorbronsdon/substack-mcp"],
      "env": {
        "SUBSTACK_PUBLICATION_URL": "https://yourblog.substack.com",
        "SUBSTACK_SESSION_TOKEN": "your-session-token",
        "SUBSTACK_USER_ID": "your-user-id"
      }
    }
  }
}
```

### 3. Verify

Ask your AI assistant: "How many Substack subscribers do I have?"

## Token expiration

Substack session tokens expire periodically. If you get authentication errors, grab a fresh `substack.sid` cookie from your browser and update the env var.

## Markdown support

The `create_draft` and `update_draft` tools accept markdown and convert it to Substack's native format. Supported:

- Paragraphs, headings (h1–h6)
- **Bold**, *italic*, `inline code`
- [Links](https://example.com)
- Images
- Bullet and numbered lists
- Code blocks (with language)
- Blockquotes
- Horizontal rules

## Important notes

- This server uses Substack's **unofficial API**. It may break if Substack changes their endpoints.
- Session tokens are sent as cookies. Keep your `SUBSTACK_SESSION_TOKEN` secure.
- The server validates authentication on startup and will fail fast if your token is expired.

## Development

```bash
git clone https://github.com/conorbronsdon/substack-mcp.git
cd substack-mcp
npm install
npm run build
```

Run locally:
```bash
SUBSTACK_PUBLICATION_URL=https://yourblog.substack.com \
SUBSTACK_SESSION_TOKEN=your-token \
SUBSTACK_USER_ID=your-id \
npm start
```

## License

MIT
