/**
 * server-turso.js
 * Servidor principal da aplicação Node.js + Express
 * Sistema de Controle de Presença do Ônibus
 * Versão para Turso (banco na nuvem)
 */

const express = require('express');
const path = require('path');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const rateLimit = require('express-rate-limit');
const { initDatabase, query, queryOne, execute } = require('./database-turso');

const app = express();
const PORT = process.env.PORT || 3000;

// Limite de assentos sentados no ônibus
const LIMITE_SENTADOS = 23;
// Quantidade de bancos traseiros
const BANCOS_TRASEIROS = 5;

// Middleware para parsing de JSON e arquivos estáticos
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────
// Rate limiting – protege a API contra abuso
// ─────────────────────────────────────────────

// Limite geral para leitura: 200 requisições por minuto por IP
const limiteGeral = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em breve.' }
});

// Limite mais restrito para escrita (POST/DELETE): 60 por minuto por IP
const limiteEscrita = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas requisições. Tente novamente em breve.' }
});

app.use('/api', limiteGeral);

// ─────────────────────────────────────────────
// Funções auxiliares
// ─────────────────────────────────────────────

/**
 * Retorna a data atual no formato YYYY-MM-DD (fuso local do servidor)
 */
function getDataHoje() {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  const dia = String(agora.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

/**
 * Verifica se ainda é possível votar (antes das 15:30)
 */
function podeVotar() {
  const agora = new Date();
  const hora = agora.getHours();
  const minuto = agora.getMinutes();
  // Bloqueia após 15:30
  return hora < 15 || (hora === 15 && minuto < 30);
}

/**
 * Calcula os assentos do dia com base nas respostas e no ponteiro de rodízio.
 * Retorna { sentados, emPe, bancosTranseiros }
 */
async function calcularAssentosDoDia(presentes) {
  if (presentes.length === 0) {
    return { sentados: [], emPe: [], bancosTraseiros: [] };
  }

  const totalPresentes = presentes.length;

  if (totalPresentes <= LIMITE_SENTADOS) {
    // Todos sentados – ainda assim calculamos os 5 bancos traseiros
    const ponteiroBancosRow = await queryOne('SELECT ponteiro FROM rotacao_bancos_traseiros WHERE id = 1');
    const ponteiroBancos = ponteiroBancosRow?.ponteiro || 0;
    const bancosTraseiros = calcularBancosTraseiros(presentes, ponteiroBancos);
    return { sentados: presentes, emPe: [], bancosTraseiros };
  }

  // Busca ponteiros de rodízio
  const ponteiroAssentosRow = await queryOne('SELECT ponteiro FROM rotacao_assentos WHERE id = 1');
  const ponteiroBancosRow = await queryOne('SELECT ponteiro FROM rotacao_bancos_traseiros WHERE id = 1');
  const ponteiroAssentos = ponteiroAssentosRow?.ponteiro || 0;
  const ponteiroBancos = ponteiroBancosRow?.ponteiro || 0;

  // Ordena presentes pela ordem da lista fixa
  const presentesOrdenados = [...presentes].sort((a, b) => a.ordem - b.ordem);
  const total = presentesOrdenados.length;

  // Aplica rodízio – começa do ponteiro (circular)
  const sentados = [];
  for (let i = 0; i < LIMITE_SENTADOS; i++) {
    const idx = (ponteiroAssentos + i) % total;
    sentados.push(presentesOrdenados[idx]);
  }

  const sentadosIds = new Set(sentados.map(p => p.id));
  const emPe = presentesOrdenados.filter(p => !sentadosIds.has(p.id));

  const bancosTraseiros = calcularBancosTraseiros(sentados, ponteiroBancos);

  return { sentados, emPe, bancosTraseiros };
}

/**
 * Seleciona 5 passageiros sentados para os bancos traseiros usando o ponteiro.
 */
function calcularBancosTraseiros(sentados, ponteiro) {
  if (sentados.length === 0) return [];
  const total = sentados.length;
  const quantidade = Math.min(BANCOS_TRASEIROS, total);
  const resultado = [];
  for (let i = 0; i < quantidade; i++) {
    const idx = (ponteiro + i) % total;
    resultado.push(sentados[idx]);
  }
  return resultado;
}

/**
 * Avança o ponteiro de rodízio de assentos para o próximo dia.
 */
async function avancarPonteiroAssentos(presentes) {
  const totalPresentes = presentes.length;
  if (totalPresentes <= LIMITE_SENTADOS) {
    return;
  }
  const ponteiroAtualRow = await queryOne('SELECT ponteiro FROM rotacao_assentos WHERE id = 1');
  const ponteiroAtual = ponteiroAtualRow?.ponteiro || 0;
  const novoPonteiro = (ponteiroAtual + LIMITE_SENTADOS) % totalPresentes;
  await execute('UPDATE rotacao_assentos SET ponteiro = ? WHERE id = 1', [novoPonteiro]);
}

/**
 * Avança o ponteiro de rodízio dos bancos traseiros.
 */
async function avancarPonteiroBancos(sentados) {
  const total = sentados.length;
  if (total === 0) return;
  const ponteiroAtualRow = await queryOne('SELECT ponteiro FROM rotacao_bancos_traseiros WHERE id = 1');
  const ponteiroAtual = ponteiroAtualRow?.ponteiro || 0;
  const novoPonteiro = (ponteiroAtual + BANCOS_TRASEIROS) % total;
  await execute('UPDATE rotacao_bancos_traseiros SET ponteiro = ? WHERE id = 1', [novoPonteiro]);
}

/**
 * Gera e salva o relatório do dia no banco.
 */
async function gerarRelatorioDoDia(data) {
  const respostas = await query(`
    SELECT p.id, p.nome, p.ordem, r.resposta
    FROM respostas_dia r
    JOIN passageiros p ON p.id = r.passageiro_id
    WHERE r.data = ?
    ORDER BY p.ordem
  `, [data]);

  if (respostas.length === 0) return null;

  const totalVouEVolto = respostas.filter(r => r.resposta === 'vou_e_volto').length;
  const totalSoVou = respostas.filter(r => r.resposta === 'so_vou').length;
  const totalSoVolto = respostas.filter(r => r.resposta === 'so_volto').length;

  const { sentados, emPe, bancosTraseiros } = await calcularAssentosDoDia(respostas);

  // Avança ponteiros para o próximo dia
  await avancarPonteiroAssentos(respostas);
  await avancarPonteiroBancos(sentados);

  const dadosJson = JSON.stringify({
    passageiros: respostas.map(r => ({ id: r.id, nome: r.nome, ordem: r.ordem, resposta: r.resposta })),
    sentados: sentados.map(p => ({ id: p.id, nome: p.nome })),
    emPe: emPe.map(p => ({ id: p.id, nome: p.nome })),
    bancosTraseiros: bancosTraseiros.map(p => ({ id: p.id, nome: p.nome }))
  });

  // Insere ou substitui o relatório
  await execute(`
    INSERT OR REPLACE INTO relatorios
      (data, total_passageiros, total_vou_e_volto, total_so_vou, total_so_volto, total_sentados, total_em_pe, dados_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `, [data, respostas.length, totalVouEVolto, totalSoVou, totalSoVolto, sentados.length, emPe.length, dadosJson]);

  // Remove relatórios com mais de 15 dias
  await execute(`DELETE FROM relatorios WHERE data < date('now', '-15 days')`);

  return { totalPassageiros: respostas.length, totalVouEVolto, totalSoVou, totalSoVolto, sentados, emPe, bancosTraseiros };
}

/**
 * Limpa as respostas da enquete do dia especificado.
 */
async function limparRespostasDia(data) {
  await execute('DELETE FROM respostas_dia WHERE data = ?', [data]);
}

// ─────────────────────────────────────────────
// Agendamento: reset diário às 00:00
// ─────────────────────────────────────────────
cron.schedule('0 0 * * *', async () => {
  const dataHoje = getDataHoje();
  console.log(`[CRON] Reset diário iniciado para ${dataHoje}`);
  await gerarRelatorioDoDia(dataHoje);
  await limparRespostasDia(dataHoje);
  console.log(`[CRON] Reset diário concluído`);
});

// ─────────────────────────────────────────────
// Rotas da API
// ─────────────────────────────────────────────

/**
 * GET /api/passageiros
 */
app.get('/api/passageiros', async (req, res) => {
  try {
    const passageiros = await query('SELECT id, nome, ordem FROM passageiros ORDER BY ordem');
    res.json(passageiros);
  } catch (err) {
    console.error('Erro ao buscar passageiros:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/respostas
 */
app.get('/api/respostas', async (req, res) => {
  try {
    const data = getDataHoje();

    const respostas = await query(`
      SELECT p.id, p.nome, p.ordem, r.resposta
      FROM respostas_dia r
      JOIN passageiros p ON p.id = r.passageiro_id
      WHERE r.data = ?
      ORDER BY p.ordem
    `, [data]);

    const mapaRespostas = {};
    respostas.forEach(r => { mapaRespostas[r.id] = r.resposta; });

    const { sentados, emPe, bancosTraseiros } = await calcularAssentosDoDia(respostas);

    res.json({
      data,
      respostas: mapaRespostas,
      resumo: {
        totalPassageiros: respostas.length,
        totalSentados: sentados.length,
        totalEmPe: emPe.length
      },
      sentados: sentados.map(p => ({ id: p.id, nome: p.nome })),
      emPe: emPe.map(p => ({ id: p.id, nome: p.nome })),
      bancosTraseiros: bancosTraseiros.map(p => ({ id: p.id, nome: p.nome }))
    });
  } catch (err) {
    console.error('Erro ao buscar respostas:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

/**
 * POST /api/respostas
 */
app.post('/api/respostas', limiteEscrita, async (req, res) => {
  try {
    if (!podeVotar()) {
      return res.status(403).json({ erro: 'Votação encerrada. Não é possível votar após 15:30.' });
    }

    const { passageiro_id, resposta, usuario_id } = req.body;

    if (!passageiro_id || !resposta) {
      return res.status(400).json({ erro: 'passageiro_id e resposta são obrigatórios' });
    }

    // Valida que usuário só pode votar por si mesmo
    if (!usuario_id || usuario_id !== passageiro_id) {
      return res.status(403).json({ erro: 'Você só pode votar por si mesmo.' });
    }

    const respostasValidas = ['vou_e_volto', 'so_vou', 'so_volto'];
    if (!respostasValidas.includes(resposta)) {
      return res.status(400).json({ erro: 'Resposta inválida' });
    }

    const passageiro = await queryOne('SELECT id FROM passageiros WHERE id = ?', [passageiro_id]);
    if (!passageiro) {
      return res.status(404).json({ erro: 'Passageiro não encontrado' });
    }

    const data = getDataHoje();

    await execute(`
      INSERT INTO respostas_dia (passageiro_id, data, resposta)
      VALUES (?, ?, ?)
      ON CONFLICT(passageiro_id, data) DO UPDATE SET resposta = excluded.resposta
    `, [passageiro_id, data, resposta]);

    res.json({ sucesso: true, passageiro_id, resposta, data });
  } catch (err) {
    console.error('Erro ao salvar resposta:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

/**
 * DELETE /api/respostas/:passageiro_id
 */
app.delete('/api/respostas/:passageiro_id', limiteEscrita, async (req, res) => {
  try {
    if (!podeVotar()) {
      return res.status(403).json({ erro: 'Votação encerrada. Não é possível alterar após 15:30.' });
    }

    const { passageiro_id } = req.params;
    const { usuario_id } = req.body || {};

    // Valida que usuário só pode remover seu próprio voto
    if (!usuario_id || parseInt(usuario_id) !== parseInt(passageiro_id)) {
      return res.status(403).json({ erro: 'Você só pode remover seu próprio voto.' });
    }

    const data = getDataHoje();
    await execute('DELETE FROM respostas_dia WHERE passageiro_id = ? AND data = ?', [passageiro_id, data]);
    res.json({ sucesso: true });
  } catch (err) {
    console.error('Erro ao remover resposta:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/relatorios
 */
app.get('/api/relatorios', async (req, res) => {
  try {
    const relatorios = await query(`
      SELECT id, data, total_passageiros, total_vou_e_volto, total_so_vou, total_so_volto, total_sentados, total_em_pe, criado_em
      FROM relatorios
      ORDER BY data DESC
    `);
    res.json(relatorios);
  } catch (err) {
    console.error('Erro ao buscar relatórios:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/relatorios/:data
 */
app.get('/api/relatorios/:data', async (req, res) => {
  try {
    const { data } = req.params;
    const relatorio = await queryOne('SELECT * FROM relatorios WHERE data = ?', [data]);
    if (!relatorio) {
      return res.status(404).json({ erro: 'Relatório não encontrado' });
    }
    relatorio.dados = JSON.parse(relatorio.dados_json);
    delete relatorio.dados_json;
    res.json(relatorio);
  } catch (err) {
    console.error('Erro ao buscar relatório:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

/**
 * POST /api/relatorios/gerar
 */
app.post('/api/relatorios/gerar', limiteEscrita, async (req, res) => {
  try {
    const data = getDataHoje();
    const resultado = await gerarRelatorioDoDia(data);
    if (!resultado) {
      return res.status(400).json({ erro: 'Nenhuma resposta encontrada para hoje' });
    }
    res.json({ sucesso: true, data, ...resultado });
  } catch (err) {
    console.error('Erro ao gerar relatório:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/relatorios/:data/csv
 */
app.get('/api/relatorios/:data/csv', async (req, res) => {
  try {
    const { data } = req.params;
    const relatorio = await queryOne('SELECT * FROM relatorios WHERE data = ?', [data]);
    if (!relatorio) {
      return res.status(404).json({ erro: 'Relatório não encontrado' });
    }

    const dados = JSON.parse(relatorio.dados_json);
    const linhas = [];

    linhas.push(`"Relatório do Ônibus - ${data}"`);
    linhas.push(`"Total de Passageiros","${relatorio.total_passageiros}"`);
    linhas.push(`"Vou e Volto","${relatorio.total_vou_e_volto}"`);
    linhas.push(`"Só Vou","${relatorio.total_so_vou}"`);
    linhas.push(`"Só Volto","${relatorio.total_so_volto}"`);
    linhas.push(`"Total Sentados","${relatorio.total_sentados}"`);
    linhas.push(`"Total em Pé","${relatorio.total_em_pe}"`);
    linhas.push('');

    linhas.push('"#","Nome","Situação","Resposta"');
    let contador = 1;

    dados.passageiros.forEach(p => {
      const sentado = dados.sentados.find(s => s.id === p.id);
      const emPe = dados.emPe.find(e => e.id === p.id);
      const traseiro = dados.bancosTraseiros.find(t => t.id === p.id);

      let situacao = 'Sentado';
      if (emPe) situacao = 'Em Pé';
      if (traseiro) situacao = 'Banco Traseiro';

      const respostaLabel = {
        vou_e_volto: 'Vou e Volto',
        so_vou: 'Só Vou',
        so_volto: 'Só Volto'
      }[p.resposta] || p.resposta;

      linhas.push(`"${contador++}","${p.nome}","${situacao}","${respostaLabel}"`);
    });

    const csvContent = linhas.join('\n');
    const filename = `relatorio-onibus-${data}.csv`;

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send('\uFEFF' + csvContent);
  } catch (err) {
    console.error('Erro ao gerar CSV:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

/**
 * GET /api/relatorios/:data/pdf
 */
app.get('/api/relatorios/:data/pdf', async (req, res) => {
  try {
    const { data } = req.params;
    const relatorio = await queryOne('SELECT * FROM relatorios WHERE data = ?', [data]);
    if (!relatorio) {
      return res.status(404).json({ erro: 'Relatório não encontrado' });
    }

    const dados = JSON.parse(relatorio.dados_json);
    const filename = `relatorio-onibus-${data}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    doc.pipe(res);

    doc.fontSize(18).font('Helvetica-Bold').text('Relatório do Ônibus', { align: 'center' });
    doc.fontSize(12).font('Helvetica').text(`Data: ${data}`, { align: 'center' });
    doc.moveDown();

    doc.fontSize(14).font('Helvetica-Bold').text('Resumo do Dia');
    doc.fontSize(11).font('Helvetica');
    doc.text(`Total de Passageiros: ${relatorio.total_passageiros}`);
    doc.text(`Vou e Volto: ${relatorio.total_vou_e_volto}`);
    doc.text(`Só Vou: ${relatorio.total_so_vou}`);
    doc.text(`Só Volto: ${relatorio.total_so_volto}`);
    doc.text(`Total Sentados: ${relatorio.total_sentados}`);
    doc.text(`Total em Pé: ${relatorio.total_em_pe}`);
    doc.moveDown();

    doc.fontSize(14).font('Helvetica-Bold').text('Passageiros Sentados');
    doc.fontSize(11).font('Helvetica');
    if (dados.sentados.length === 0) {
      doc.text('Nenhum');
    } else {
      dados.sentados.forEach((p, i) => doc.text(`${i + 1}. ${p.nome}`));
    }
    doc.moveDown();

    doc.fontSize(14).font('Helvetica-Bold').text('Passageiros em Pé');
    doc.fontSize(11).font('Helvetica');
    if (dados.emPe.length === 0) {
      doc.text('Nenhum');
    } else {
      dados.emPe.forEach((p, i) => doc.text(`${i + 1}. ${p.nome}`));
    }
    doc.moveDown();

    doc.fontSize(14).font('Helvetica-Bold').text('Bancos Traseiros do Dia');
    doc.fontSize(11).font('Helvetica');
    if (dados.bancosTraseiros.length === 0) {
      doc.text('Nenhum');
    } else {
      dados.bancosTraseiros.forEach((p, i) => doc.text(`${i + 1}. ${p.nome}`));
    }
    doc.moveDown();

    doc.fontSize(14).font('Helvetica-Bold').text('Lista Completa de Passageiros');
    doc.fontSize(11).font('Helvetica');
    dados.passageiros.forEach((p, i) => {
      const label = { vou_e_volto: 'Vou e Volto', so_vou: 'Só Vou', so_volto: 'Só Volto' }[p.resposta] || p.resposta;
      doc.text(`${i + 1}. ${p.nome} — ${label}`);
    });

    doc.end();
  } catch (err) {
    console.error('Erro ao gerar PDF:', err);
    res.status(500).json({ erro: 'Erro interno do servidor' });
  }
});

// Rota para a página administrativa
app.get('/admin', limiteGeral, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Inicia o servidor após inicializar o banco
async function startServer() {
  try {
    await initDatabase();
    app.listen(PORT, () => {
      console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
      console.log(`📊 Painel admin em http://localhost:${PORT}/admin`);
    });
  } catch (err) {
    console.error('❌ Erro ao iniciar servidor:', err);
    process.exit(1);
  }
}

startServer();

module.exports = app;
