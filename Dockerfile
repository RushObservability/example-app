FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY . .

# Default: gateway. Override CMD per service in docker-compose.
CMD ["node", "--require", "./tracing.js", "gateway.js"]
