# Cloud Run Job image. Runs one poll and exits — Cloud Scheduler invokes it on
# a cron schedule, so the container only exists for a few seconds at a time.
FROM node:22-slim

WORKDIR /app

# Install production deps first for better layer caching.
COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY data/sample_trades.json ./data/sample_trades.json

# --once: poll a single time and exit (the scheduler handles repetition).
CMD ["node", "src/index.js", "--once"]
