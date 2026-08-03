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
# tsconfig has no test exclusion, so tsc emits src/__tests__ into dist. Those
# files import vitest, which --omit=dev correctly leaves out, so they are dead
# weight and scanner surface in a published image.
RUN rm -rf dist/__tests__

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
CMD ["node", "dist/index.js"]
