# INTLY MinIO image

This image builds MinIO from the official source tag `RELEASE.2025-09-07T16-13-09Z` because the matching prebuilt community container is no longer available from the official registries used by production.

Build contract:

- source repository: `https://github.com/minio/minio.git`
- tag: `RELEASE.2025-09-07T16-13-09Z`
- required commit: `07c3a429bfed433e49018cb0f78a52145d4bedeb`
- Go toolchain image: `golang:1.27.1-alpine`, the current supported stable Go release verified from `https://go.dev/dl/?mode=json`
- build command mirrors the upstream Makefile shape: `GOTOOLCHAIN=local CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -tags kqueue -trimpath`
- release ldflags are produced by upstream `buildscripts/gen-ldflags.go` with `GOTOOLCHAIN=local`, `MINIO_RELEASE=RELEASE`, and version `2025-09-07T16:13:09Z`

Runtime contract:

- non-root user/group `10001:10001`
- data directory `/data`
- ports `9000` and `9001`
- liveness healthcheck: `GET /minio/health/live` through `curl`
- no dependency on unavailable MinIO base images or the `mc` client

The production compose/deploy layer should inject the immutable image reference through `MINIO_IMAGE`.
