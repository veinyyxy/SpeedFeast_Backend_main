# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force


FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY public/verification ./public/verification
RUN npm run build


FROM node:24-bookworm-slim AS rds-certificates

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --silent --show-error --location \
        https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
        --output /aws-rds-global-bundle.pem \
    && grep -q "BEGIN CERTIFICATE" /aws-rds-global-bundle.pem \
    && chmod 0444 /aws-rds-global-bundle.pem \
    && rm -rf /var/lib/apt/lists/*


FROM node:24-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    PGSSLROOTCERT=/usr/local/share/ca-certificates/aws-rds-global-bundle.pem

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json app.js ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node db ./db
COPY --chown=node:node public ./public
COPY --chown=node:node routes ./routes
COPY --chown=node:node secutiry ./secutiry
COPY --chown=node:node services ./services
COPY --chown=node:node views ./views
COPY --from=build --chown=node:node /app/public/out ./public/out
COPY --from=rds-certificates /aws-rds-global-bundle.pem /usr/local/share/ca-certificates/aws-rds-global-bundle.pem

# Keep the legacy static/upload path writable without baking uploaded files
# into the immutable image.
RUN mkdir -p /app/images \
    && chown node:node /app/images

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "./bin/www"]
