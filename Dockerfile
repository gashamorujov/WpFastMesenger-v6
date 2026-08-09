FROM node:20-slim

# git needed for realtime auto-update (VPS bind-mounted source)
RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production && npm cache clean --force

COPY . .

RUN mkdir -p temp sessions data

ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "index.js"]
