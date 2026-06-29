FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
