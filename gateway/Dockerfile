# Build context: repository root (the image needs both web/ and gateway/).
# The gateway serves the GUI and its API from one port.

# ---- Stage 1: GUI bundle, talking to the real gateway API ----
FROM node:22-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ .
ENV VITE_USE_MOCK=false
RUN npm run typecheck && npm test && npx vite build

# ---- Stage 2: gateway binary with the bundle embedded ----
FROM golang:1.27 AS builder
WORKDIR /src
COPY gateway/go.mod gateway/go.sum ./
RUN go mod download
COPY gateway/ .
COPY --from=web /web/dist/ ./webui/dist/
ARG VERSION=docker
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /gateway ./cmd/gateway \
 && mkdir -p /data

# ---- Stage 3: minimal runtime, no shell, non-root ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=builder /gateway /app/gateway
# Owned by the runtime user so a fresh named volume mounted here is writable.
COPY --from=builder --chown=65532:65532 /data /data
ENV GATEWAY_LISTEN=:8080 \
    PEERS_CONFIG=/app/config/peers.yaml \
    NODE_CONFIG=/app/config/node.yaml \
    GATEWAY_DB=/data/gateway.db
USER 65532:65532
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 CMD ["/app/gateway", "-healthcheck"]
ENTRYPOINT ["/app/gateway"]
