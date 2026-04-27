/**
 * database.js
 * Inicialização e configuração do banco de dados SQLite
 */

const Database = require('better-sqlite3');
const path = require('path');

// Caminho do arquivo do banco de dados (permite injetar por variável de ambiente para volumes no Fly.io)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'onibus.db');

// Conecta (ou cria) o banco de dados
const db = new Database(DB_PATH);

// Habilita WAL mode para melhor performance
db.pragma('journal_mode = WAL');

/**
 * Cria todas as tabelas necessárias se não existirem
 */
function initDatabase() {
  // Tabela de passageiros (lista fixa)
  db.exec(`
    CREATE TABLE IF NOT EXISTS passageiros (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE,
      ordem INTEGER NOT NULL,
      cadeira_fixa INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Adiciona coluna cadeira_fixa se não existir (para bancos existentes)
  try {
    db.exec(`ALTER TABLE passageiros ADD COLUMN cadeira_fixa INTEGER NOT NULL DEFAULT 0`);
  } catch (e) {
    // Coluna já existe, ignorar
  }

  // Tabela de respostas diárias da enquete
  db.exec(`
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
  db.exec(`
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

  // Tabela de controle do ponteiro de rodízio dos assentos (em pé)
  // id=1 = IDA, id=2 = VOLTA
  db.exec(`
    CREATE TABLE IF NOT EXISTS rotacao_assentos (
      id INTEGER PRIMARY KEY CHECK(id IN (1, 2)),
      ponteiro INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Tabela de controle do ponteiro de rodízio dos bancos traseiros
  // id=1 = IDA, id=2 = VOLTA
  db.exec(`
    CREATE TABLE IF NOT EXISTS rotacao_bancos_traseiros (
      id INTEGER PRIMARY KEY CHECK(id IN (1, 2)),
      ponteiro INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Inicializa ponteiros se não existirem (ida=1, volta=2)
  db.exec(`
    INSERT OR IGNORE INTO rotacao_assentos (id, ponteiro) VALUES (1, 0);
    INSERT OR IGNORE INTO rotacao_assentos (id, ponteiro) VALUES (2, 0);
    INSERT OR IGNORE INTO rotacao_bancos_traseiros (id, ponteiro) VALUES (1, 0);
    INSERT OR IGNORE INTO rotacao_bancos_traseiros (id, ponteiro) VALUES (2, 0);
  `);

  // Tabela de configurações gerais do sistema
  db.exec(`
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    )
  `);

  // Inicializa configurações padrão
  db.exec(`
    INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES ('limite_sentados', '23');
    INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES ('bancos_traseiros', '5');
  `);

  // Popula a lista de passageiros se ainda não existir
  const count = db.prepare('SELECT COUNT(*) as c FROM passageiros').get();
  if (count.c === 0) {
    const passageiros = [
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

    const insert = db.prepare('INSERT INTO passageiros (nome, ordem) VALUES (?, ?)');
    const insertMany = db.transaction((lista) => {
      lista.forEach((nome, index) => {
        insert.run(nome, index + 1);
      });
    });
    insertMany(passageiros);
  }
}

// Inicializa o banco de dados ao carregar o módulo
initDatabase();

module.exports = db;
