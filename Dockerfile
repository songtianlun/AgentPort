# Stage 1: Build shared React + Vite frontend
FROM node:22-alpine AS frontend-builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
RUN npm run build

# Stage 2: Build pure-Go single binary with embedded frontend assets
FROM golang:1.23-alpine AS backend-builder
WORKDIR /src/server-go

RUN apk add --no-cache git ca-certificates

COPY server-go/ ./
RUN rm -rf ./static/dist && mkdir -p ./static/dist
COPY --from=frontend-builder /app/dist/ ./static/dist/

ARG VERSION=dev
RUN go mod tidy && \
    CGO_ENABLED=0 go build \
      -trimpath \
      -ldflags="-s -w -X main.Version=${VERSION}" \
      -o /out/agentport-server .

# Stage 3: Minimal production runtime image
FROM alpine:3.21
WORKDIR /app

RUN apk add --no-cache ca-certificates tzdata wget && \
    addgroup -g 1000 agentport && \
    adduser -D -u 1000 -G agentport agentport && \
    mkdir -p /data && \
    chown -R agentport:agentport /data /app

COPY --from=backend-builder /out/agentport-server /usr/local/bin/agentport-server

USER agentport

ENV AGENTPORT_ADDR=:8080 \
    AGENTPORT_DATA_DIR=/data

EXPOSE 8080
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/api/v1/health || exit 1

ENTRYPOINT ["/usr/local/bin/agentport-server"]
