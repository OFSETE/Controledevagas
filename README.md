# Controle de Vagas — Sistema de Presença do Ônibus

Sistema web minimalista para gerenciamento diário de passageiros de ônibus. Controla presença, rodízio de assentos e geração automática de relatórios.

## Funcionalidades

- ✅ Lista fixa de 31 passageiros em ordem alfabética
- ✅ Enquete diária de presença (Vou e Volto / Só Vou / Só Volto)
- ✅ Limite de 23 assentos com rodízio rotativo automático
- ✅ Rodízio dos 5 bancos traseiros (ponteiro separado)
- ✅ Reset automático às 00:00 com geração de relatório
- ✅ Exportação de relatórios em CSV e PDF
- ✅ Histórico de 15 dias com limpeza automática
- ✅ Painel administrativo em `/admin`
- ✅ Interface mobile-first responsiva
- ✅ Rate limiting para proteção da API

## Tecnologias

- **Backend:** Node.js + Express
- **Banco de dados:** SQLite (via better-sqlite3)
- **Agendamento:** node-cron
- **PDF:** PDFKit
- **Frontend:** HTML, CSS e JavaScript puro (sem frameworks)

## Instalação

```bash
npm install
npm start
```

O servidor inicia em `http://localhost:3000`.

## Páginas

| Página | Descrição |
|--------|-----------|
| `/` | Enquete de presença diária |
| `/admin` | Painel administrativo com histórico |

## API

| Método | Rota | Descrição |
|--------|------|-----------|
| GET | `/api/passageiros` | Lista todos os passageiros |
| GET | `/api/respostas` | Respostas do dia com cálculo de assentos |
| POST | `/api/respostas` | Registra/atualiza resposta de um passageiro |
| DELETE | `/api/respostas/:id` | Remove resposta de um passageiro |
| GET | `/api/relatorios` | Lista relatórios salvos |
| GET | `/api/relatorios/:data` | Detalhes de um relatório |
| POST | `/api/relatorios/gerar` | Gera relatório do dia manualmente |
| GET | `/api/relatorios/:data/csv` | Exporta relatório como CSV |
| GET | `/api/relatorios/:data/pdf` | Exporta relatório como PDF |

## Banco de dados

Tabelas SQLite criadas automaticamente:

- `passageiros` — lista fixa de passageiros
- `respostas_dia` — respostas diárias da enquete
- `relatorios` — relatórios gerados
- `rotacao_assentos` — ponteiro do rodízio de assentos
- `rotacao_bancos_traseiros` — ponteiro do rodízio dos bancos traseiros
