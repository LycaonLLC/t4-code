# syntax=docker/dockerfile:1.7

FROM docker.io/library/debian:bookworm-slim AS omp-runtime
ARG TARGETARCH
RUN rm -f /etc/apt/sources.list.d/* \
    && printf '%s\n' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20250721T000000Z bookworm main' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20250721T000000Z bookworm-security main' \
       > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
RUN case "${TARGETARCH}" in \
      amd64) asset=omp-linux-x64; sha256=6054460b29e9bad5eba78336f291e1979c2fa0a5cd96fc2d92afd666cc681d26 ;; \
      arm64) asset=omp-linux-arm64; sha256=e5f77cb65aa2dc777a8a5932be3b2e6a44271c8df2eb209cea6f04f212f3f010 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
    && mkdir -p /opt/t4/bin \
    && curl --fail --location --silent --show-error \
       "https://github.com/can1357/oh-my-pi/releases/download/v18.0.11/${asset}" \
       --output /opt/t4/bin/omp \
    && echo "${sha256}  /opt/t4/bin/omp" | sha256sum --check --strict \
    && chmod 0755 /opt/t4/bin/omp

FROM docker.io/library/node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7 AS t4-build
WORKDIR /opt/t4
COPY . /opt/t4
RUN corepack enable \
    && pnpm install --frozen-lockfile --ignore-scripts

FROM docker.io/oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f
USER root
RUN rm -f /etc/apt/sources.list.d/* \
    && printf '%s\n' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20250721T000000Z bookworm main' \
       'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20250721T000000Z bookworm-security main' \
       > /etc/apt/sources.list \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends \
       bash ca-certificates chromium fluxbox git openssh-client python3 ripgrep tini xvfb \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/t4/bin /workspace /run/t4 \
    && chown -R 10001:10001 /workspace /run/t4
COPY --from=omp-runtime /opt/t4/bin/omp /opt/t4/bin/omp
COPY --from=t4-build /opt/t4 /opt/t4
COPY cluster/images/session-runtime/session-entrypoint.sh /opt/t4/bin/session-entrypoint
RUN chmod 0755 /opt/t4/bin/omp /opt/t4/bin/session-entrypoint \
    && chown -R 10001:10001 /opt/t4
ENV T4_OMP_EXECUTABLE=/opt/t4/bin/omp \
    T4_WORKSPACE_ROOT=/workspace \
    T4_HOST_PORT=8787 \
    DISPLAY=:99 \
    HOME=/workspace/.t4/runtime \
    XDG_RUNTIME_DIR=/run/t4
ARG SOURCE_REPOSITORY=https://github.com/LycaonLLC/t4-code
LABEL org.opencontainers.image.source="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.title="T4 OMP session runtime" \
      io.t4.omp.version="18.0.11" \
      io.t4.omp.tag="v18.0.11" \
      io.t4.omp.commit="b8ce33a58911c26bed1d84f0db9a5e2e727c49a2" \
      io.t4.omp.authority="official-omp-jsonl" \
      io.t4.gui.display="Xvfb"
USER 10001:10001
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/t4/bin/session-entrypoint"]
