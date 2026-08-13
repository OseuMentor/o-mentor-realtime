FROM node:20-bullseye-slim

WORKDIR /app

COPY package.json ./

RUN yarn install --production --network-timeout 600000

COPY . .

ENV NODE_ENV=production

CMD ["node", "realtime-gateway.js"]
