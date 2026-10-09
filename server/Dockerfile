# ==============================================================================
#  服务端镜像（NestJS + node:sqlite）
#
#  分两阶段，是为了让最终镜像里**没有** typescript / ts-node / 测试代码：
#     build   装全量依赖 → 编译 dist
#     runtime 只装生产依赖 + 拷 dist
#
#  构建（在 server/ 下）：
#     docker build -t olua-server .
#  跑（数据要挂出来，否则容器重建就丢库）：
#     docker run -d -p 3100:3100 -v olua-data:/app/data --env-file .env olua-server
#
#  注意：镜像里**不含 .env**（见 .dockerignore）—— 密钥只在运行时注入。
# ==============================================================================

FROM node:22-alpine AS build
WORKDIR /app
# 依赖清单先单独拷：只改源码时这一层能命中缓存，不必重新 npm ci
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# 数据目录：先把属主给 node 用户，这样具名卷第一次初始化时也带着正确属主
# （compose 会把卷挂到 /app/data，路径见 docker-compose.yml 的 DB_PATH）
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 3100

# 健康检查用 Node 自带的 fetch：alpine 里没有 curl，也不值得为它多装一个包
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/'+(process.env.API_PREFIX||'api')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
