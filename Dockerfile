FROM node:20-slim

# Install FFmpeg + font fallback (DejaVu) so drawtext always has something to use
RUN apt-get update && \
    apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core fonts-liberation && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p output fonts music

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
