# ==============================================================================
#  管理端镜像（React + Vite 构建 → nginx 静态托管）
#
#  **地址是构建期决定的**：Vite 把 `VITE_API_BASE_URL` 内联进产物，所以换后端地址要**重新构建**，
#  不是改运行时的环境变量（这是最容易搞错的一处）。默认 `/api` —— 配合 nginx 的同源反代，
#  浏览器根本不会发跨域请求（于是服务端也不需要配 CORS_ORIGINS）。
#
#  构建：
#     docker build -t olua-admin .
#     docker build -t olua-admin --build-arg VITE_API_BASE_URL=https://api.example.com/api .
# ==============================================================================

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_BASE_URL=/api
# 传成环境变量，Vite 的 loadEnv 会把 VITE_ 前缀的 process.env 一起收进 import.meta.env
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
