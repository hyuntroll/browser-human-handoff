FROM node:22-bookworm

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  bash \
  curl \
  openssl \
  ca-certificates \
  xpra \
  chromium \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./

RUN npm install --no-fund --no-audit

COPY . .

RUN chmod +x tools/browser-hitl/*.sh tools/browser-hitl/browser-control.mjs

CMD ["npm", "run", "test:hitl"]
