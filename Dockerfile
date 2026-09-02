# substack-mcp — MCP server for Substack (stdio by default, HTTP optional)
# Build:  docker build -t substack-mcp .
# Run (stdio, the default — spawned per session by the MCP client):
#   docker run -i --rm \
#     -e SUBSTACK_PUBLICATION_URL=https://example.substack.com \
#     -e SUBSTACK_SESSION_TOKEN=... \
#     -e SUBSTACK_USER_ID=... \
#     substack-mcp
# Run (HTTP, for a persistent service behind e.g. `mcp-remote`):
#   docker run -d --restart unless-stopped -p 8080:8080 \
#     -e MCP_TRANSPORT=http \
#     -e SUBSTACK_PUBLICATION_URL=https://example.substack.com \
#     -e SUBSTACK_SESSION_TOKEN=... \
#     -e SUBSTACK_USER_ID=... \
#     substack-mcp

# Pin the multi-architecture base for reproducible MCP Catalog builds.
# Dependabot checks the Node 22 / Alpine 3.24 tag weekly for a new digest.
FROM node:22-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32 AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build

FROM node:22-alpine3.24@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist ./dist

# Credentials come from the environment and are never baked into the image:
#   SUBSTACK_PUBLICATION_URL — e.g. https://example.substack.com
#   SUBSTACK_SESSION_TOKEN   — the `connect.sid` cookie value (`substack.sid`
#                              on a *.substack.com domain)
#   SUBSTACK_USER_ID         — numeric Substack user id
# All three are optional at startup. The server starts without them and answers
# introspection (initialize, tools/list); each tool call then returns
# isError: true until the credentials are set. The message points at the failing
# request path rather than naming the missing variable, which is worth tightening
# in the server itself. The browser-login flow that writes
# ~/.substack-mcp/session.json binds its key to the OS account and hostname, so
# a stored session is not portable into a container — use the env vars here.

USER node
EXPOSE 8080
CMD ["node", "dist/index.js"]
