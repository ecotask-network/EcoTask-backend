FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production && \
    cp -R node_modules /prod_modules && \
    npm ci

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json prisma ./ 
COPY prisma ./prisma
RUN npx prisma generate
COPY src ./src
RUN npm run build

FROM node:20-alpine AS runtime
RUN apk add --no-cache curl && \
    addgroup -g 1001 -S ecotask && \
    adduser -S ecotask -u 1001

WORKDIR /app
COPY --from=deps /prod_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY prisma ./prisma

RUN mkdir -p /tmp/uploads && chown -R ecotask:ecotask /tmp/uploads
USER ecotask

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/app.js"]
