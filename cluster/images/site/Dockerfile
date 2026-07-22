# syntax=docker/dockerfile:1.7
FROM docker.io/library/node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7 AS build
WORKDIR /opt/t4

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/site/package.json apps/site/package.json
RUN corepack enable \
    && pnpm install --filter @t4-code/site... --frozen-lockfile

COPY apps/site/ apps/site/
RUN pnpm --filter @t4-code/site build

FROM docker.io/nginxinc/nginx-unprivileged:1.29.4-alpine3.23@sha256:a6c4f61f456b85b8fdf7ec7ab28cc3e299440e6fb4a9dea520e5fd8fd440025e
ARG SOURCE_REPOSITORY=https://github.com/LycaonLLC/t4-code
LABEL org.opencontainers.image.source="${SOURCE_REPOSITORY}" \
      org.opencontainers.image.title="T4 Code website"

COPY <<'EOF' /etc/nginx/conf.d/default.conf
server {
    listen 8080;
    listen [::]:8080;
    server_name _;

    root /usr/share/nginx/html;
    index index.html;
    charset utf-8;
    server_tokens off;

    location = /healthz {
        access_log off;
        default_type text/plain;
        add_header Cache-Control "no-store" always;
        return 200 "ok\n";
    }

    location /assets/ {
        try_files $uri =404;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    location ~* \.html$ {
        try_files $uri =404;
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
    }

    location / {
        try_files $uri $uri/ =404;
        add_header Cache-Control "public, max-age=3600" always;
    }

    error_page 404 /404.html;
}
EOF

COPY --from=build --chown=101:101 /opt/t4/apps/site/dist/ /usr/share/nginx/html/

USER 101:101
EXPOSE 8080
ENTRYPOINT []
CMD ["nginx", "-g", "daemon off;"]
