# pirate container image.
#
# The image carries the musl artifact that `cargo xtask dist` writes. The final
# stage is distroless, so the image holds the binary and nothing else.
#
# `cargo xtask dist` needs mise, because mise installs the pinned build tools.
# That command stops without it. See docs/building.md.
#
# Build one image for this host:
#   cargo xtask dist --target x86_64-unknown-linux-musl
#   docker build -t pirate:0.1.0 .
#
# Build both architectures:
#   cargo xtask dist --target x86_64-unknown-linux-musl \
#                    --target aarch64-unknown-linux-musl
#   docker buildx build --platform linux/amd64,linux/arm64 -t pirate:0.1.0 .
#
# The build context needs dist/ only. See .dockerignore.
#
# This file pins both base images by digest, because a tag moves. To upgrade a base
# image, read the new digest with `docker buildx imagetools inspect <image>:<tag>`.

# ---------------------------------------------------------------------------
# Stage 1 — read the checksum, then unpack the tarball for the target
# architecture. This stage runs on the build host, so it needs no emulator.
# ---------------------------------------------------------------------------
FROM --platform=$BUILDPLATFORM alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce AS unpack

ARG TARGETARCH
WORKDIR /work
COPY dist/ /work/dist/

RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) triple=x86_64-unknown-linux-musl ;; \
      arm64) triple=aarch64-unknown-linux-musl ;; \
      *) echo "unsupported architecture $TARGETARCH"; exit 1 ;; \
    esac; \
    archive="$(ls dist/pirate-*-${triple}.tar.gz)"; \
    name="$(basename "$archive")"; \
    want="$(awk -v f="$name" '$2 == f { print $1 }' dist/SHA256SUMS)"; \
    got="$(sha256sum "$archive" | cut -d' ' -f1)"; \
    if [ -z "$want" ]; then \
      echo "dist/SHA256SUMS has no line for $name"; exit 1; \
    fi; \
    if [ "$want" != "$got" ]; then \
      echo "checksum mismatch for $name"; echo "  want $want"; echo "  got  $got"; exit 1; \
    fi; \
    tar -xzf "$archive"; \
    binary="$(find . -type f -name pirate | head -n 1)"; \
    if [ -z "$binary" ]; then \
      echo "$name holds no file named pirate"; exit 1; \
    fi; \
    mkdir -p /out; \
    cp "$binary" /out/pirate; \
    chmod 0755 /out/pirate

# ---------------------------------------------------------------------------
# Stage 2 — the image that ships. distroless static holds the CA certificates,
# the time zone data, and the passwd file. It holds no shell and no package
# manager. The musl binary is static, so it needs nothing else.
# ---------------------------------------------------------------------------
FROM gcr.io/distroless/static-debian12:nonroot@sha256:f5b485ea962d9bd1186b2f6b3a061191539b905b82ec395de78cbfae51f20e35

COPY --from=unpack /out/pirate /usr/local/bin/pirate

# EXPOSE is documentation. It publishes nothing.
EXPOSE 10433

# This file does not set PIRATE_BIND. The default bind address of pirate is
# 127.0.0.1.
#
# A container that binds the loopback address answers nothing on a published
# port. That result is correct. The operator selects a wider bind, one
# command at a time:
#
#   docker run --rm -it -p 127.0.0.1:10433:10433 -e PIRATE_BIND=0.0.0.0 pirate:0.1.0
#
# This command keeps the container port on the loopback address of the host.
# pirate serves TLS on 10433 by default, so the browser URL is
# https://127.0.0.1:10433.

USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/pirate"]
