FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --prefer-offline

COPY . .

ARG VITE_BACKEND_NEXT_BASE_URL=
ENV VITE_BACKEND_NEXT_BASE_URL=${VITE_BACKEND_NEXT_BASE_URL}

RUN npm run build

FROM nginx:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1
