# Build context: repository root (the image needs both node/ and sim/).
# One image for every node: the Go binary plus the Python/SimPy runtime.

# ---- Stage 1: build the Go binary ----
# Use a Go release that still receives security fixes: net/http and crypto
# are compiled into the binary, so an EOL toolchain ships known CVEs.
FROM golang:1.27 AS builder
WORKDIR /src
COPY node/go.mod node/go.sum ./
RUN go mod download
COPY node/ .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /node-bin ./cmd/node

# ---- Stage 2: Python runtime + Go binary ----
FROM python:3.11-slim
WORKDIR /app
COPY sim/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 && useradd --system --uid 10001 --home-dir /nonexistent --shell /usr/sbin/nologin app
# Code stays root-owned and read-only to the runtime user.
COPY sim/simulate.py sim/netsim.py ./sim/
COPY --from=builder /node-bin /app/node-bin

ENV PEERS_CONFIG=/app/config/peers.yaml \
    PYTHONDONTWRITEBYTECODE=1

USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=5 \
    CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2).status == 200 else 1)"
ENTRYPOINT ["/app/node-bin"]
