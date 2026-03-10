/**
 * server.js
 * Servidor principal da aplicação Node.js + Express
 * Sistema de Controle de Presença do Ônibus
 */

const express = require('express');
const path = require('path');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const rateLimit = require('express-rate-limit');
const db = require('./database');

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
function calcularAssentosDoDia(presentes) {
  if (presentes.length === 0) {
    return { sentados: [], emPe: [], bancosTraseiros: [] };
  }

  const totalPresentes = presentes.length;

  if (totalPresentes <= LIMITE_SENTADOS) {
    // Todos sentados – ainda assim calculamos os 5 bancos traseiros
    const ponteiroBancos = db.prepare('SELECT ponteiro FROM rotacao_bancos_traseiros WHERE id = 1').get().ponteiro;
    const bancosTraseiros = calcularBancosTraseiros(presentes, ponteiroBancos);
    return { sentados: presentes, emPe: [], bancosTraseiros };
  }

  // Busca ponteiro de rodízio
  const ponteiroAssentos = db.prepare('SELECT ponteiro FROM rotacao_assentos WHERE id = 1').get().ponteiro;
  const ponteiroBancos = db.prepare('SELECT ponteiro FROM rotacao_bancos_traseiros WHERE id = 1').get().ponteiro;

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
 * O próximo ponto deve ser o índice seguinte ao último sentado do dia.
 */
function avancarPonteiroAssentos(presentes) {
  const totalPresentes = presentes.length;
  if (totalPresentes <= LIMITE_SENTADOS) {
    // Todos sentados, ponteiro não muda
    return;
  }
  const ponteiroAtual = db.prepare('SELECT ponteiro FROM rotacao_assentos WHERE id = 1').get().ponteiro;
  const novoPonteiro = (ponteiroAtual + LIMITE_SENTADOS) % totalPresentes;
  db.prepare('UPDATE rotacao_assentos SET ponteiro = ? WHERE id = 1').run(novoPonteiro);
}

/**
 * Avança o ponteiro de rodízio dos bancos traseiros.
 */
function avancarPonteiroBancos(sentados) {
  const total = sentados.length;
  if (total === 0) return;
  const ponteiroAtual = db.prepare('SELECT ponteiro FROM rotacao_bancos_traseiros WHERE id = 1').get().ponteiro;
  const novoPonteiro = (ponteiroAtual + BANCOS_TRASEIROS) % total;
  db.prepare('UPDATE rotacao_bancos_traseiros SET ponteiro = ? WHERE id = 1').run(novoPonteiro);
}

/**
 * Gera e salva o relatório do dia no banco.
 * Também avança os ponteiros para o próximo dia.
 * Remove relatórios com mais de 15 dias.
 */
function gerarRelatorioDoDia(data) {
  const respostas = db.prepare(`
    SELECT p.id, p.nome, p.ordem, r.resposta
    FROM respostas_dia r
    JOIN passageiros p ON p.id = r.passageiro_id
    WHERE r.data = ?
    ORDER BY p.ordem
  `).all(data);

  if (respostas.length === 0) return null;

  const totalVouEVolto = respostas.filter(r => r.resposta === 'vou_e_volto').length;
  const totalSoVou = respostas.filter(r => r.resposta === 'so_vou').length;
  const totalSoVolto = respostas.filter(r => r.resposta === 'so_volto').length;

  const { sentados, emPe, bancosTraseiros } = calcularAssentosDoDia(respostas);

  // Avança ponteiros para o próximo dia
  avancarPonteiroAssentos(respostas);
  avancarPonteiroBancos(sentados);

  const dadosJson = JSON.stringify({
    passageiros: respostas.map(r => ({ id: r.id, nome: r.nome, ordem: r.ordem, resposta: r.resposta })),
    sentados: sentados.map(p => ({ id: p.id, nome: p.nome })),
    emPe: emPe.map(p => ({ id: p.id, nome: p.nome })),
    bancosTraseiros: bancosTraseiros.map(p => ({ id: p.id, nome: p.nome }))
  });

  // Insere ou substitui o relatório
  db.prepare(`
    INSERT OR REPLACE INTO relatorios
      (data, total_passageiros, total_vou_e_volto, total_so_vou, total_so_volto, total_sentados, total_em_pe, dados_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data,
    respostas.length,
    totalVouEVolto,
    totalSoVou,
    totalSoVolto,
    sentados.length,
    emPe.length,
    dadosJson
  );

  // Remove relatórios com mais de 15 dias
  db.prepare(`
    DELETE FROM relatorios
    WHERE data < date('now', '-15 days')
  `).run();

  return { totalPassageiros: respostas.length, totalVouEVolto, totalSoVou, totalSoVolto, sentados, emPe, bancosTraseiros };
}

/**
 * Limpa as respostas da enquete do dia especificado.
 */
function limparRespostasDia(data) {
  db.prepare('DELETE FROM respostas_dia WHERE data = ?').run(data);
}

// ─────────────────────────────────────────────
// Agendamento: reset diário às 00:00
// ─────────────────────────────────────────────
cron.schedule('0 0 * * *', () => {
  const dataHoje = getDataHoje();
  console.log(`[CRON] Reset diário iniciado para ${dataHoje}`);
  gerarRelatorioDoDia(dataHoje);
  limparRespostasDia(dataHoje);
  console.log(`[CRON] Reset diário concluído`);
});

// ─────────────────────────────────────────────
// Rotas da API
// ─────────────────────────────────────────────

/**
 * GET /api/passageiros
 * Retorna lista de todos os passageiros em ordem alfabética
 */
app.get('/api/passageiros', (req, res) => {
  const passageiros = db.prepare('SELECT id, nome, ordem FROM passageiros ORDER BY ordem').all();
  res.json(passageiros);
});

/**
 * GET /api/respostas
 * Retorna as respostas de hoje com dados calculados (sentados, em pé, bancos traseiros)
 */
app.get('/api/respostas', (req, res) => {
  const data = getDataHoje();

  const respostas = db.prepare(`
    SELECT p.id, p.nome, p.ordem, r.resposta
    FROM respostas_dia r
    JOIN passageiros p ON p.id = r.passageiro_id
    WHERE r.data = ?
    ORDER BY p.ordem
  `).all(data);

  // Mapa de id -> resposta para fácil consulta no frontend
  const mapaRespostas = {};
  respostas.forEach(r => { mapaRespostas[r.id] = r.resposta; });

  const { sentados, emPe, bancosTraseiros } = calcularAssentosDoDia(respostas);

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
});

/**
 * POST /api/respostas
 * Salva ou atualiza a resposta de um passageiro
 * Body: { passageiro_id, resposta }
 */
app.post('/api/respostas', limiteEscrita, (req, res) => {
  // Verifica se ainda está no horário permitido para votar
  if (!podeVotar()) {
    return res.status(403).json({ erro: 'Votação encerrada. Não é possível votar após 15:30.' });
  }

  const { passageiro_id, resposta } = req.body;

  if (!passageiro_id || !resposta) {
    return res.status(400).json({ erro: 'passageiro_id e resposta são obrigatórios' });
  }

  const respostasValidas = ['vou_e_volto', 'so_vou', 'so_volto'];
  if (!respostasValidas.includes(resposta)) {
    return res.status(400).json({ erro: 'Resposta inválida' });
  }

  // Verifica se o passageiro existe
  const passageiro = db.prepare('SELECT id FROM passageiros WHERE id = ?').get(passageiro_id);
  if (!passageiro) {
    return res.status(404).json({ erro: 'Passageiro não encontrado' });
  }

  const data = getDataHoje();

  db.prepare(`
    INSERT INTO respostas_dia (passageiro_id, data, resposta)
    VALUES (?, ?, ?)
    ON CONFLICT(passageiro_id, data) DO UPDATE SET resposta = excluded.resposta
  `).run(passageiro_id, data, resposta);

  res.json({ sucesso: true, passageiro_id, resposta, data });
});

/**
 * DELETE /api/respostas/:passageiro_id
 * Remove a resposta de um passageiro para hoje (desmarca)
 */
app.delete('/api/respostas/:passageiro_id', limiteEscrita, (req, res) => {
  // Verifica se ainda está no horário permitido para votar
  if (!podeVotar()) {
    return res.status(403).json({ erro: 'Votação encerrada. Não é possível alterar após 15:30.' });
  }

  const { passageiro_id } = req.params;
  const data = getDataHoje();
  db.prepare('DELETE FROM respostas_dia WHERE passageiro_id = ? AND data = ?').run(passageiro_id, data);
  res.json({ sucesso: true });
});

/**
 * GET /api/relatorios
 * Lista todos os relatórios salvos (últimos 15 dias)
 */
app.get('/api/relatorios', (req, res) => {
  const relatorios = db.prepare(`
    SELECT id, data, total_passageiros, total_vou_e_volto, total_so_vou, total_so_volto, total_sentados, total_em_pe, criado_em
    FROM relatorios
    ORDER BY data DESC
  `).all();
  res.json(relatorios);
});

/**
 * GET /api/relatorios/:data
 * Retorna o relatório de uma data específica (YYYY-MM-DD)
 */
app.get('/api/relatorios/:data', (req, res) => {
  const { data } = req.params;
  const relatorio = db.prepare('SELECT * FROM relatorios WHERE data = ?').get(data);
  if (!relatorio) {
    return res.status(404).json({ erro: 'Relatório não encontrado' });
  }
  relatorio.dados = JSON.parse(relatorio.dados_json);
  delete relatorio.dados_json;
  res.json(relatorio);
});

/**
 * POST /api/relatorios/gerar
 * Gera manualmente o relatório do dia atual (uso administrativo)
 */
app.post('/api/relatorios/gerar', limiteEscrita, (req, res) => {
  const data = getDataHoje();
  const resultado = gerarRelatorioDoDia(data);
  if (!resultado) {
    return res.status(400).json({ erro: 'Nenhuma resposta encontrada para hoje' });
  }
  res.json({ sucesso: true, data, ...resultado });
});

/**
 * GET /api/relatorios/:data/csv
 * Exporta o relatório de uma data como CSV
 */
app.get('/api/relatorios/:data/csv', (req, res) => {
  const { data } = req.params;
  const relatorio = db.prepare('SELECT * FROM relatorios WHERE data = ?').get(data);
  if (!relatorio) {
    return res.status(404).json({ erro: 'Relatório não encontrado' });
  }

  const dados = JSON.parse(relatorio.dados_json);
  const linhas = [];

  // Cabeçalho do relatório
  linhas.push(`"Relatório do Ônibus - ${data}"`);
  linhas.push(`"Total de Passageiros","${relatorio.total_passageiros}"`);
  linhas.push(`"Vou e Volto","${relatorio.total_vou_e_volto}"`);
  linhas.push(`"Só Vou","${relatorio.total_so_vou}"`);
  linhas.push(`"Só Volto","${relatorio.total_so_volto}"`);
  linhas.push(`"Total Sentados","${relatorio.total_sentados}"`);
  linhas.push(`"Total em Pé","${relatorio.total_em_pe}"`);
  linhas.push('');

  // Lista completa de passageiros do dia
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
  res.send('\uFEFF' + csvContent); // BOM para Excel reconhecer UTF-8
});

/**
 * GET /api/relatorios/:data/pdf
 * Exporta o relatório de uma data como PDF
 */
app.get('/api/relatorios/:data/pdf', (req, res) => {
  const { data } = req.params;
  const relatorio = db.prepare('SELECT * FROM relatorios WHERE data = ?').get(data);
  if (!relatorio) {
    return res.status(404).json({ erro: 'Relatório não encontrado' });
  }

  const dados = JSON.parse(relatorio.dados_json);
  const filename = `relatorio-onibus-${data}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  doc.pipe(res);

  // Título
  doc.fontSize(18).font('Helvetica-Bold').text('Relatório do Ônibus', { align: 'center' });
  doc.fontSize(12).font('Helvetica').text(`Data: ${data}`, { align: 'center' });
  doc.moveDown();

  // Resumo
  doc.fontSize(14).font('Helvetica-Bold').text('Resumo do Dia');
  doc.fontSize(11).font('Helvetica');
  doc.text(`Total de Passageiros: ${relatorio.total_passageiros}`);
  doc.text(`Vou e Volto: ${relatorio.total_vou_e_volto}`);
  doc.text(`Só Vou: ${relatorio.total_so_vou}`);
  doc.text(`Só Volto: ${relatorio.total_so_volto}`);
  doc.text(`Total Sentados: ${relatorio.total_sentados}`);
  doc.text(`Total em Pé: ${relatorio.total_em_pe}`);
  doc.moveDown();

  // Passageiros sentados
  doc.fontSize(14).font('Helvetica-Bold').text('Passageiros Sentados');
  doc.fontSize(11).font('Helvetica');
  if (dados.sentados.length === 0) {
    doc.text('Nenhum');
  } else {
    dados.sentados.forEach((p, i) => doc.text(`${i + 1}. ${p.nome}`));
  }
  doc.moveDown();

  // Passageiros em pé
  doc.fontSize(14).font('Helvetica-Bold').text('Passageiros em Pé');
  doc.fontSize(11).font('Helvetica');
  if (dados.emPe.length === 0) {
    doc.text('Nenhum');
  } else {
    dados.emPe.forEach((p, i) => doc.text(`${i + 1}. ${p.nome}`));
  }
  doc.moveDown();

  // Bancos traseiros
  doc.fontSize(14).font('Helvetica-Bold').text('Bancos Traseiros do Dia');
  doc.fontSize(11).font('Helvetica');
  if (dados.bancosTraseiros.length === 0) {
    doc.text('Nenhum');
  } else {
    dados.bancosTraseiros.forEach((p, i) => doc.text(`${i + 1}. ${p.nome}`));
  }
  doc.moveDown();

  // Lista completa
  doc.fontSize(14).font('Helvetica-Bold').text('Lista Completa de Passageiros');
  doc.fontSize(11).font('Helvetica');
  dados.passageiros.forEach((p, i) => {
    const label = { vou_e_volto: 'Vou e Volto', so_vou: 'Só Vou', so_volto: 'Só Volto' }[p.resposta] || p.resposta;
    doc.text(`${i + 1}. ${p.nome} — ${label}`);
  });

  doc.end();
});

// Rota para a página administrativa (com rate limit geral)
app.get('/admin', limiteGeral, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Inicia o servidor
app.listen(PORT, () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
  console.log(`📊 Painel admin em http://localhost:${PORT}/admin`);
});

module.exports = app;
