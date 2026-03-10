# 🚀 Deploy do Sistema de Controle do Ônibus

## Passo 1: Criar conta no Turso (Banco de Dados)

1. Acesse: https://turso.tech
2. Crie uma conta gratuita (pode usar GitHub)
3. No dashboard, clique em **"Create Database"**
4. Dê um nome: `onibus-db`
5. Escolha a região mais próxima (ex: São Paulo)
6. Após criar, clique no banco e vá em **"Connect"**
7. Copie:
   - **Database URL**: `libsql://onibus-db-seuusuario.turso.io`
   - **Auth Token**: clique em "Generate Token" e copie

---

## Passo 2: Criar conta no Render (Servidor)

1. Acesse: https://render.com
2. Crie uma conta gratuita (pode usar GitHub)
3. Conecte seu repositório GitHub

---

## Passo 3: Deploy no Render

1. No Render, clique em **"New +"** → **"Web Service"**
2. Conecte seu repositório `Controledevagas`
3. Configure:
   - **Name**: `controle-onibus` (ou outro nome)
   - **Region**: escolha a mais próxima
   - **Branch**: `OFFSET-ENTERPRISE` (ou sua branch principal)
   - **Build Command**: `npm install`
   - **Start Command**: `node server-turso.js`
4. Em **Environment Variables**, adicione:
   - `TURSO_DATABASE_URL` → cole a URL do Turso
   - `TURSO_AUTH_TOKEN` → cole o token do Turso
5. Clique em **"Create Web Service"**

---

## Passo 4: Aguarde o Deploy

- O Render vai instalar as dependências e iniciar o servidor
- Após alguns minutos, você receberá uma URL como:
  `https://controle-onibus.onrender.com`

---

## 🎉 Pronto!

Compartilhe o link com sua equipe de 31 pessoas!

### URLs do sistema:
- **Página principal**: `https://seu-app.onrender.com`
- **Painel admin**: `https://seu-app.onrender.com/admin`
- **Senha do admin**: `147258`

---

## ⚠️ Observações

### Plano Gratuito do Render:
- O servidor "dorme" após 15 minutos de inatividade
- Demora ~30 segundos para "acordar" na primeira requisição
- Para manter sempre ativo, considere um plano pago ($7/mês)

### Turso Gratuito:
- 9GB de storage
- 1 bilhão de leituras/mês
- Suficiente para seu uso

---

## 🔧 Desenvolvimento Local

Para testar localmente com Turso:

```bash
# Instale as dependências
npm install

# Crie um arquivo .env com suas credenciais
cp .env.example .env
# Edite o .env com suas credenciais do Turso

# Execute o servidor
npm run start:cloud
```

Para executar localmente com SQLite (sem Turso):

```bash
npm start
```
