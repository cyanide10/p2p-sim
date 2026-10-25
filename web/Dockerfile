# Build context: web/. Serves the GUI as static files from unprivileged nginx.

# ---- Stage 1: build the static bundle ----
FROM node:22-alpine AS builder
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# "true" bundles the mock API (no gateway needed); "false" calls the gateway at /api.
ARG VITE_USE_MOCK=true
ENV VITE_USE_MOCK=${VITE_USE_MOCK}
RUN npm run typecheck && npm test && npx vite build

# ---- Stage 2: static file server ----
# nginx-unprivileged runs as uid 101 and listens on 8080, so no capabilities are needed.
FROM nginxinc/nginx-unprivileged:1.29-alpine
USER root
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf security-headers.conf /etc/nginx/
COPY --from=builder /src/dist /usr/share/nginx/html
USER 101
ENV NGINX_ENTRYPOINT_QUIET_LOGS=1
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/index.html || exit 1
