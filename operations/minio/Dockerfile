# syntax=docker/dockerfile:1.7

ARG MINIO_REPOSITORY=https://github.com/minio/minio.git
ARG MINIO_TAG=RELEASE.2025-09-07T16-13-09Z
ARG MINIO_COMMIT=07c3a429bfed433e49018cb0f78a52145d4bedeb
ARG MINIO_VERSION=2025-09-07T16:13:09Z

FROM --platform=$BUILDPLATFORM golang:1.27.1-alpine AS build
ARG TARGETOS
ARG TARGETARCH
ARG MINIO_REPOSITORY
ARG MINIO_TAG
ARG MINIO_COMMIT
ARG MINIO_VERSION

RUN apk add --no-cache bash ca-certificates git
WORKDIR /src/minio
RUN git clone --branch "${MINIO_TAG}" --depth 1 "${MINIO_REPOSITORY}" . \
  && test "$(git rev-parse HEAD)" = "${MINIO_COMMIT}"
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    MINIO_RELEASE=RELEASE GOTOOLCHAIN=local CGO_ENABLED=0 GOOS="${TARGETOS}" GOARCH="${TARGETARCH}" \
    go build -tags kqueue -trimpath \
      --ldflags "$(MINIO_RELEASE=RELEASE GOTOOLCHAIN=local go run buildscripts/gen-ldflags.go "${MINIO_VERSION}")" \
      -o /out/minio

FROM alpine:3.22
RUN apk add --no-cache ca-certificates curl \
  && addgroup -S -g 10001 minio \
  && adduser -S -D -H -u 10001 -G minio minio \
  && mkdir -p /data \
  && chown -R minio:minio /data
COPY --from=build /out/minio /usr/local/bin/minio
USER 10001:10001
VOLUME ["/data"]
EXPOSE 9000 9001
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:9000/minio/health/live || exit 1
ENTRYPOINT ["/usr/local/bin/minio"]
CMD ["server", "/data", "--console-address", ":9001"]
