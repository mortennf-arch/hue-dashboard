# Bygger TypeScript i ett steg og kjører bare den ferdige JavaScript-koden i det neste.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PAIR_TIMEOUT_S=0 \
    TZ=Europe/Oslo
COPY package.json ./
COPY --from=build /app/dist ./dist
# TrueNAS kjører appen som brukeren "apps" (568). Mappen /data kobles til et dataset.
RUN mkdir -p /data && chown 568:568 /data
VOLUME ["/data"]
USER 568:568
CMD ["node", "dist/main.js"]
