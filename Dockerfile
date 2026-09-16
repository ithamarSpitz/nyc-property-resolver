FROM node:22-bookworm-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json tsconfig.build.json jest.config.cjs ./
COPY src ./src
RUN npm run build

COPY tests ./tests

CMD ["npm", "run", "start:api"]
