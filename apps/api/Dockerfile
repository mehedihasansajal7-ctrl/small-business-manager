# Small Business Manager — one container serving the API and the built web app.
#
# The Android APK only needs the API; the browser client is served from the same
# origin so its session cookie is first-party and there is no CORS to configure.
#
#   docker build -f apps/api/Dockerfile -t small-business-manager .
#   docker run -p 8080:8080 -v sbm-data:/app/data small-business-manager
#
# Node 24 is required: the API uses the built-in `node:sqlite`.

# ---------------------------------------------------------------- build stage
FROM node:24-slim AS build
WORKDIR /app

# Copy only the manifests first so `npm ci` is cached across source edits.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/domain/package.json packages/domain/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY supabase/package.json supabase/
RUN npm ci --no-audit --no-fund

COPY packages/domain packages/domain
COPY apps/api apps/api
COPY apps/web apps/web
COPY supabase supabase

RUN npm run build:domain \
 && npm run build -w @sbm/api \
 && npm run build -w @sbm/web

# -------------------------------------------------------------- runtime stage
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data \
    WEB_DIR=/app/apps/web/dist \
    DEFAULT_TIMEZONE=Asia/Dhaka \
    DEFAULT_CURRENCY=BDT \
    DEFAULT_LOCALE=bn-BD

# The whole built tree is copied so the workspace symlinks (@sbm/domain) stay valid.
COPY --from=build /app /app

# The database, uploaded attachments and daily backups live here — mount a volume
# or a redeploy would start from an empty business.
RUN mkdir -p /app/data
VOLUME ["/app/data"]

EXPOSE 8080

# A container that cannot answer /api/health is not ready.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/api/dist/server.js"]
