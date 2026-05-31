# Reproducible build container for Late-Meet Chrome Extension
# Produces a production-ready extension bundle in /app/dist/
#
# Usage:
#   docker build -t late-meet-build .
#   docker run --rm -v $(pwd)/dist:/app/dist late-meet-build
#
# This container is for CI/CD and reproducible builds only.
# Late-Meet is a Chrome Extension — it does not run as a server.

FROM node:18-alpine@sha256:c8511739c9f2858b97d25e0be951f28b7e6de59012353e6b7d2bf64a2754d924 AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Output stage — minimal image containing only the built extension
FROM alpine:3.19 AS output
WORKDIR /app
COPY --from=builder /app/dist ./dist

# Default command outputs build info for CI verification
CMD ["ls", "-la", "/app/dist"]
