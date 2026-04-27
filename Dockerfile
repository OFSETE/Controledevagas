FROM node:20-slim

WORKDIR /app

# Instalar dependências necessárias para compilar o better-sqlite3 e para fuso horário
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    sqlite3 \
    libsqlite3-dev \
    tzdata \
    && rm -rf /var/lib/apt/lists/*

# Configurar fuso horário para o Brasil
ENV TZ="America/Sao_Paulo"

COPY package*.json ./
RUN npm install

COPY . .

# Diretório onde o banco de dados persistente será montado
RUN mkdir -p /data
ENV DB_PATH="/data/onibus.db"

EXPOSE 3000

CMD ["npm", "start"]
