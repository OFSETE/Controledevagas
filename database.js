/**
 * database.js
 * Inicialização e configuração do banco de dados Turso (libSQL)
 */

const { createClient } = require('@libsql/client');

const DB_URL = process.env.TURSO_DATABASE_URL || 'file:onibus.db';
const DB_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

const db = createClient({
  url: DB_URL,
  authToken: DB_AUTH_TOKEN,
});

async function initDatabase() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS passageiros (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      cadeira_fixa INTEGER DEFAULT 0
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS respostas_dia (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      passageiro_id INTEGER NOT NULL,
      data TEXT NOT NULL,
      resposta TEXT NOT NULL,
      UNIQUE(passageiro_id, data)
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS relatorios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data TEXT NOT NULL UNIQUE,
      total_passageiros INTEGER,
      vou_e_volto INTEGER,
      so_vou INTEGER,
      so_volto INTEGER,
      sentados_ida TEXT,
      em_pe_ida TEXT,
      bancos_traseiros_ida TEXT,
      sentados_volta TEXT,
      em_pe_volta TEXT,
      bancos_traseiros_volta TEXT
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS rotacao_assentos (
      id INTEGER PRIMARY KEY,
      ponteiro INTEGER DEFAULT 0
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS rotacao_bancos_traseiros (
      id INTEGER PRIMARY KEY,
      ponteiro INTEGER DEFAULT 0
    )
  `);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    )
  `);

  await db.execute("INSERT OR IGNORE INTO rotacao_assentos (id, ponteiro) VALUES (1, 0)");
  await db.execute("INSERT OR IGNORE INTO rotacao_assentos (id, ponteiro) VALUES (2, 0)");

  await db.execute("INSERT OR IGNORE INTO rotacao_bancos_traseiros (id, ponteiro) VALUES (1, 0)");
  await db.execute("INSERT OR IGNORE INTO rotacao_bancos_traseiros (id, ponteiro) VALUES (2, 0)");

  await db.execute("INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES ('limite_sentados', '23')");
  await db.execute("INSERT OR IGNORE INTO configuracoes (chave, valor) VALUES ('bancos_traseiros', '5')");

  // Popula a lista se estiver vazia
  const { rows } = await db.execute("SELECT COUNT(*) as count FROM passageiros");
  if (Number(rows[0].count) === 0) {
    const nomesIniciais = [
      'Alana', 'Alcicleia', 'Ana', 'Antônia', 'Aquila', 'Aurilene', 'Breno', 'Carmelita',
      'Charles', 'Cheilane', 'Danilo', 'Denise', 'Dilza', 'Dona Lurdes', 'Elias', 'Eliane',
      'Flavia', 'Francyane', 'Helena', 'Ivone', 'Jose', 'Leane', 'Leandro', 'Livia',
      'Lidiane', 'Lurdinha', 'Lucas', 'Luzia', 'Marcela', 'Maria', 'Marcos', 'M. Das Dores',
      'Matheus', 'Natalia', 'Nazaré', 'Poliana', 'Raifran', 'Raimundo', 'Rosy', 'Rosyane',
      'Sabrina', 'Vitoria', 'Vitoria A', 'Zeze', 'Ronaldi', 'Wallas'
    ];

    for (const nome of nomesIniciais) {
      let cadeiraFixa = 0;
      if (['Dona Lurdes', 'Zeze', 'Luzia', 'Maria', 'Ronaldi', 'Wallas'].includes(nome)) {
        cadeiraFixa = 1;
      }
      await db.execute({
        sql: "INSERT INTO passageiros (nome, cadeira_fixa) VALUES (?, ?)",
        args: [nome, cadeiraFixa]
      });
    }
  }
}

module.exports = { db, initDatabase };
