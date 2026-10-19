FROM node:22-bookworm-slim
ENV NODE_ENV=production CHROME_PATH=/usr/bin/chromium HOME=/tmp
RUN apt-get update && apt-get install -y --no-install-recommends chromium fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY public ./public
USER node
EXPOSE 4310 4311
CMD ["node", "src/server.js"]
