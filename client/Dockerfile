# === Build stage ===
FROM node:24 AS builder
ARG VITE_APP_BACKEND
ARG VITE_APP_NAME
ENV VITE_APP_BACKEND=$VITE_APP_BACKEND
ENV VITE_APP_NAME=$VITE_APP_NAME

RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY client/package*.json ./client/
RUN cd client && npm install

COPY client ./client
COPY common ./common

# 👇 Rebuild and build with injected env
RUN cd client && npm rebuild rollup && npm run build

# === Runtime stage ===
FROM node:24 AS runtime

RUN npm install -g serve
WORKDIR /app

COPY --from=builder /app/client/dist ./dist
COPY client/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENV VITE_APP_BACKEND=$VITE_APP_BACKEND
ENV VITE_APP_NAME=$VITE_APP_NAME

EXPOSE 4501

# ✅ This is the missing piece:
ENTRYPOINT ["/entrypoint.sh"]

# This is still your main server command
CMD ["serve", "-s", "dist", "-l", "4501"]

# === Dev stage (hot reload via Vite dev server) ===
FROM node:24 AS dev

WORKDIR /app/client

COPY client/package*.json ./
RUN npm install

EXPOSE 4501

CMD ["npm", "run", "dev"]