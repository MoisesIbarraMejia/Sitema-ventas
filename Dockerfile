FROM node:20-slim

# Instalamos paquetes necesarios y separamos la limpieza con un && limpio
RUN apt-get update && apt-get install -y \
    chromium \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./

RUN npm install --only=production

COPY . .

EXPOSE 7860

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

CMD ["node", "src/index.js"]