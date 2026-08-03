# substack-mcp — stdio MCP server for Substack
# Build:  docker build -t substack-mcp .
# Run:    docker run -i --rm \
#           -e SUBSTACK_PUBLICATION_URL=https://example.substack.com \
#           -e SUBSTACK_SESSION_TOKEN=... \
#           -e SUBSTACK_USER_ID=... \
#           substack-mcp

FROM node:22-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
COPY src ./src
RUN npm ci --ignore-scripts && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist ./dist

# Credentials come from the environment and are never baked into the image:
#   SUBSTACK_PUBLICATION_URL — e.g. https://example.substack.com
#   SUBSTACK_SESSION_TOKEN   — the `substack.sid` cookie value
#   SUBSTACK_USER_ID         — numeric Substack user id
# All three are optional at startup. The server starts without them and answers
# introspection (initialize, tools/list); each tool call then fails with a clear
# error until the credentials are set. The browser-login flow that writes
# ~/.substack-mcp/session.json binds its key to the OS account and hostname, so
# a stored session is not portable into a container — use the env vars here.

USER node
CMD ["node", "dist/index.js"]
