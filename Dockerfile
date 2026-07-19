FROM node:20-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

FROM node:20-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .
ENV NODE_ENV=production
ENV PORT=3000
ENV DB_PATH=/data/crm.db
EXPOSE 3000
CMD ["node", "server.js"]
