# ==========================================
# Estágio 1: Build & Dependências
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

# Habilita Corepack e Pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copia manifestos de dependência
COPY package.json pnpm-lock.yaml* tsconfig.json ./

# Instala dependências completas para compilação
RUN pnpm install --frozen-lockfile

# Copia código fonte
COPY src ./src

# Executa Typecheck e compilação ESM via tsup
RUN pnpm run typecheck && pnpm run build

# Isola apenas dependências de produção
RUN pnpm prune --prod

# ==========================================
# Estágio 2: Imagem Final de Execução
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

# Cria usuário não-privilegiado por segurança de plataforma
USER node

# Copia apenas os artefatos compilados e dependências essenciais
COPY --chown=node:node --from=builder /app/package.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health/live || exit 1

CMD ["node", "dist/server.js"]
