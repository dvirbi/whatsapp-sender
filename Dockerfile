FROM node:20-slim

# Install Puppeteer dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-noto-color-emoji \
    fonts-noto-cjk \
    fonts-open-sans \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./

EXPOSE 3000
CMD ["node", "server.js"]
