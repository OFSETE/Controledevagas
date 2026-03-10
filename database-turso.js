/**
 * database-turso.js
 * Configuração do banco de dados Turso (LibSQL)
 */

const { createClient } = require('@libsql/client');

// Configuração do Turso via variáveis de ambiente
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN
});

/**
 * Lista de passageiros inicial
 */
const PASSAGEIROS_INICIAIS = [
  'Ana Beatriz da Silva Galdino',
  'Ana Vitória Vieira da Silva',
  'Antônia Edna Máximo da Silva',
  'Antônia Maria Lorena Gregório Bezerra',
  'Danielle Oliveira Lima Alves',
  'Danise Quitéria Lima de Sousa',
  'Davi Gino André',
  'Davit Kauã Silva',
  'Erislânia Monteiro Araújo',
  'Felipe Gomes Pereira',
  'Fernando Luiz Alves Holanda',
  'Flávia Alessandra Araújo Vieira',
  'Francisca Evelyn Guedes de Sousa',
  'Francisco Ramon de Oliveira Pinho',
  'Francisco Samuel Freitas Silva',
  'Gabriel Martins dos Santos',
  'Giovanna Garcia Inácio',
  'Guilherme Leonardo Bezerra',
  'Ingrid Jamily Souza Bezerra',
  'Isabelle das Neves Oliveira',
  'João Carlos de Pádua Francelino',
  'Joyce Duarte da Silva',
  'Lara Gaspar da Silva',
  'Letícia Bezerra da Silva',
  'Letycia Gomes Costa',
  'Matheus Filipe Alves Marinho',
  'Nara Samily Gomes de Meneses',
  'Pedro Henrique de Souza Araújo',
  'Pedro Jeferson Oliveira da Silva',
  'Raimundo Ruan de Oliveira Freitas',
  'Vitória Kelly Rodrigues'
];

/**
 * Cria todas as tabelas necessárias se não existirem
 */
async function initDatabase() {
  // Tabela de passageiros (lista fixa)
  await db.execute(`
    CREATE TABLE IF NOT EXISTS passageiros (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE,
      ordem INTEGER NOT NULL
    )
  `);

  // Tabela de respostas diárias da enquete
  await db.execute(`
    CREATE TABLE IF NOT EXISTS respostas_dia (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      passageiro_id INTEGER NOT NULL,
      data TEXT NOT NULL,
      resposta TEXT NOT NULL CHECK(resposta IN ('vou_e_volto', 'so_vou', 'so_volto')),
      FOREIGN KEY (passageiro_id) REFERENCES passageiros(id),
      UNIQUE(passageiro_id, data)
    )
  `);

  // Tabela de relatórios diários
  await db.execute(`
    CREATE TABLE IF NOT EXISTS relatorios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL UNIQUE,
      total_passageiros INTEGER NOT NULL DEFAULT 0,
      total_vou_e_volto INTEGER NOT NULL DEFAULT 0,
      total_so_vou INTEGER NOT NULL DEFAULT 0,
      total_so_volto INTEGER NOT NULL DEFAULT 0,
      total_sentados INTEGER NOT NULL DEFAULT 0,
      total_em_pe INTEGER NOT NULL DEFAULT 0,
      dados_json TEXT NOT NULL DEFAULT '{}',
      criado_em TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Tabela de controle do ponteiro de rodízio dos assentos
  await db.execute(`
    CREATE TABLE IF NOT EXISTS rotacao_assentos (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      ponteiro INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Tabela de controle do ponteiro de rodízio dos bancos traseiros
  await db.execute(`
    CREATE TABLE IF NOT EXISTS rotacao_bancos_traseiros (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      ponteiro INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Inicializa ponteiros se não existirem
  await db.execute(`INSERT OR IGNORE INTO rotacao_assentos (id, ponteiro) VALUES (1, 0)`);
  await db.execute(`INSERT OR IGNORE INTO rotacao_bancos_traseiros (id, ponteiro) VALUES (1, 0)`);

  // Popula a lista de passageiros se ainda não existir
  const count = await db.execute('SELECT COUNT(*) as c FROM passageiros');
  if (count.rows[0].c === 0) {
    for (let i = 0; i < PASSAGEIROS_INICIAIS.length; i++) {
      await db.execute({
        sql: 'INSERT INTO passageiros (nome, ordem) VALUES (?, ?)',
        args: [PASSAGEIROS_INICIAIS[i], i + 1]
      });
    }
    console.log('✅ Passageiros iniciais inseridos no banco');
  }

  console.log('✅ Banco de dados inicializado');
}

// Funções auxiliares para consultas
async function query(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows;
}

async function queryOne(sql, args = []) {
  const result = await db.execute({ sql, args });
  return result.rows[0] || null;
}

async function execute(sql, args = []) {
  return await db.execute({ sql, args });
}

module.exports = {
  db,
  initDatabase,
  query,
  queryOne,
  execute
};
