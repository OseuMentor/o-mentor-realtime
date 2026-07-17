FROM node:20-bullseye-slim

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production

CMD ["node", "realtime-gateway.js"]
