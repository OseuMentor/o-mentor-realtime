FROM node:20-alpine

WORKDIR /app

RUN npm install -g npm@latest

COPY package.json package-lock.json ./

RUN npm install --omit=dev --no-audit --no-fund

COPY . .

ENV NODE_ENV=production

CMD ["node", "realtime-gateway.js"]
