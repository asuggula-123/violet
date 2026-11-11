# Violet production image. Build: docker build -t violet .
# No secrets, .env files or tests go into the image (see .dockerignore); every
# secret is an env var set at run time (fly secrets set, docker run -e).

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# tsc to dist/ and copies src/db/migrations/*.sql to dist/db/migrations/.
RUN npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
# The app and its files stay root-owned and read-only to the process.
USER node
EXPOSE 8080
# Exec form: node is the process that receives SIGTERM (main.ts shuts down cleanly).
CMD ["node", "dist/main.js"]
