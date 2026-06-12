FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching
COPY package.json ./
RUN npm install --omit=dev

# App source
COPY . .

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/index.js"]
