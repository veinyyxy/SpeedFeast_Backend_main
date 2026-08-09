# syntax=docker/dockerfile:1.7

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force \
    && install --directory --mode=0755 --owner=65532 --group=65532 /runtime-images


FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY public/verification ./public/verification
RUN npm run build


FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS rds-certificates

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --silent --show-error --location \
        https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
        --output /aws-rds-global-bundle.pem \
    && echo "e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3  /aws-rds-global-bundle.pem" \
        | sha256sum --check --strict \
    && grep -q "BEGIN CERTIFICATE" /aws-rds-global-bundle.pem \
    && chmod 0444 /aws-rds-global-bundle.pem \
    && rm -rf /var/lib/apt/lists/*


FROM gcr.io/distroless/cc-debian12:nonroot@sha256:fccdbb0a547c14e23fcf4ce8ad62ca5d43b4faae8d22cd292f490fef9946c96e AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PGSSLMODE=verify-full \
    PGSSL_REJECT_UNAUTHORIZED=true \
    PGSSLROOTCERT=/usr/local/share/ca-certificates/aws-rds-global-bundle.pem

WORKDIR /app

COPY --from=production-dependencies /usr/local/bin/node /usr/local/bin/node
COPY --from=production-dependencies --chown=65532:65532 /app/node_modules ./node_modules
COPY --chown=65532:65532 package.json package-lock.json app.js ./
COPY --chown=65532:65532 bin ./bin
COPY --chown=65532:65532 db ./db
COPY --chown=65532:65532 public ./public
COPY --chown=65532:65532 routes ./routes
COPY --chown=65532:65532 secutiry ./secutiry
COPY --chown=65532:65532 services ./services
COPY --chown=65532:65532 views ./views
COPY --from=build --chown=65532:65532 /app/public/out ./public/out
COPY --from=rds-certificates /aws-rds-global-bundle.pem /usr/local/share/ca-certificates/aws-rds-global-bundle.pem
COPY --from=production-dependencies --chown=65532:65532 /runtime-images/ ./images/

# The pinned distroless nonroot identity is uid/gid 65532. The final image has
# no shell, package manager, npm/Yarn or Perl; migrations run with node directly.
USER 65532:65532

# Fail the image build if the copied binary is not the reviewed Node release or
# if the only native production dependency cannot load on distroless/glibc.
RUN ["/usr/local/bin/node", "-e", "if (process.version !== 'v24.18.0') throw new Error('unexpected Node runtime'); const bcrypt = require('bcrypt'); const hash = bcrypt.hashSync('runtime-smoke', 4); if (!bcrypt.compareSync('runtime-smoke', hash)) throw new Error('bcrypt runtime smoke test failed');"]

EXPOSE 3000

STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD ["/usr/local/bin/node", "-e", "fetch('http://127.0.0.1:3000/ready').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

ENTRYPOINT []

CMD ["/usr/local/bin/node", "./bin/www"]
