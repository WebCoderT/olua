# ==============================================================================
#  管理端镜像（React + Vite 构建 → nginx 静态托管）
#
#  **地址是构建期决定的**：Vite 把 `VITE_API_BASE_URL` 内联进产物，所以换后端地址要**重新构建**，
#  不是改运行时的环境变量（这是最容易搞错的一处）。默认 `/api` —— 配合 nginx 的同源反代，
#  浏览器根本不会发跨域请求（于是服务端也不需要配 CORS_ORIGINS）。
#
#  **构建上下文是仓库根**（compose 里 `context: .` + `dockerfile: admin/Dockerfile`）：
#  `admin/src/api/gameData.ts` 要 import 服务端的 `server/src/common/constants/game-enums`
#  （枚举与结构常量一份真源，不许两端各抄一份）。context 只给 `admin/` 时那个相对路径
#  落到上下文外面，构建期就是 TS2307。根目录 `.dockerignore` 负责把 client/ 等大目录挡在外面。
#
#  构建（**在仓库根执行**）：
#     docker build -f admin/Dockerfile -t olua-admin .
#     docker build -f admin/Dockerfile -t olua-admin --build-arg VITE_API_BASE_URL=https://api.example.com/api .
# ==============================================================================

FROM node:22-alpine AS build
# 目录形状必须与仓库一致：admin/src/api/gameData.ts 里的 ../../.. 是相对 `admin/` 往上三层
WORKDIR /repo
COPY admin/package.json admin/package-lock.json ./admin/
RUN cd admin && npm ci
COPY admin ./admin
# 只为那条跨端 import 存在：少这一层，tsc 在 build 阶段就找不到模块
COPY server/src/common/constants ./server/src/common/constants
ARG VITE_API_BASE_URL=/api
# 传成环境变量，Vite 的 loadEnv 会把 VITE_ 前缀的 process.env 一起收进 import.meta.env
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN cd admin && npm run build

FROM nginx:1.27-alpine AS runtime
COPY --from=build /repo/admin/dist /usr/share/nginx/html
COPY admin/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
