/**
 * server.js
 * Servidor principal da aplicação Node.js + Express
 * Sistema de Controle de Presença do Ônibus
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const PDFDocument = require('pdfkit');
const rateLimit = require('express-rate-limit');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurações do sistema (via .env ou valores padrão)
// LIMITE_SENTADOS agora é buscado dinamicamente do banco de dados através da função await getLimiteSentados()
// BANCOS_TRASEIROS agora é buscado dinamicamente do banco de dados através da função await getBancosTraseiros()
const LIMITE_PARA_BANCOS_TRASEIROS = parseInt(process.env.LIMITE_PARA_BANCOS_TRASEIROS) || 18;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '147258';

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
 * Retorna o limite de pessoas sentadas definido nas configurações do banco.
 */
async function getLimiteSentados() {
  try {
    const row = (await db.execute("SELECT valor FROM configuracoes WHERE chave = 'limite_sentados'")).rows[0];
    return parseInt(row?.valor) || 23;
  } catch (e) {
    return 23; // fallback caso a tabela ainda não exista
  }
}

/**
 * Retorna a quantidade de bancos traseiros definida nas configurações do banco.
 */
async function getBancosTraseiros() {
  try {
    const row = (await db.execute("SELECT valor FROM configuracoes WHERE chave = 'bancos_traseiros'")).rows[0];
    return row ? parseInt(row.valor) : 5;
  } catch (e) {
    return 5; // fallback caso a tabela ainda não exista
  }
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
 * Retorna { sentados, emPe, bancosTranseiros, cadeirasFixas }
 * Nota: bancos traseiros só são calculados quando há mais de 18 passageiros
 * Nota: pessoas com cadeira_fixa são sempre sentadas e não participam dos rodízios
 * 
 * Rodízio Em Pé: A-Z (Ana primeiro, depois Antônia, etc.)
 * Rodízio Bancos Traseiros: Z-A (Vitória primeiro, depois Raimundo, etc.)
 * 
 * @param {Array} presentes - Lista de passageiros presentes
 * @param {number} tipoRodizio - 1 para IDA, 2 para VOLTA
 */
async function calcularAssentosDoDia(presentes, tipoRodizio = 1) {
  if (presentes.length === 0) {
    return { sentados: [], emPe: [], bancosTraseiros: [], cadeirasFixas: [] };
  }

  // Separa passageiros com cadeira fixa dos demais
  const cadeirasFixas = presentes.filter(p => p.cadeira_fixa === 1);
  const participantesRodizio = presentes.filter(p => p.cadeira_fixa !== 1);

  const totalPresentes = presentes.length;
  const limiteSentados = await getLimiteSentados();
  const lugaresDisponiveis = limiteSentados - cadeirasFixas.length;

  // Caso todos caibam sentados
  if (participantesRodizio.length <= lugaresDisponiveis) {
    // Todos sentados
    const sentados = [...cadeirasFixas, ...participantesRodizio];
    let bancosTraseiros = [];
    
    // Bancos traseiros só se > 18 pessoas (excluindo cadeiras fixas do rodízio)
    if (totalPresentes > LIMITE_PARA_BANCOS_TRASEIROS && participantesRodizio.length > 0) {
      const ponteiroBancos = (await db.execute({ sql: 'SELECT ponteiro FROM rotacao_bancos_traseiros WHERE id = ?', args: [tipoRodizio] })).rows[0].ponteiro;
      bancosTraseiros = await calcularBancosTraseiros(participantesRodizio, ponteiroBancos, totalPresentes);
    }
    return { sentados, emPe: [], bancosTraseiros, cadeirasFixas };
  }

  // Busca ponteiros de rodízio (usando tipoRodizio: 1=ida, 2=volta)
  const ponteiroEmPe = (await db.execute({ sql: 'SELECT ponteiro FROM rotacao_assentos WHERE id = ?', args: [tipoRodizio] })).rows[0].ponteiro;
  const ponteiroBancos = (await db.execute({ sql: 'SELECT ponteiro FROM rotacao_bancos_traseiros WHERE id = ?', args: [tipoRodizio] })).rows[0].ponteiro;

  // Ordena participantes A-Z para rodízio de em pé
  const participantesAZ = [...participantesRodizio].sort((a, b) => a.nome.localeCompare(b.nome));
  const total = participantesAZ.length;
  
  // Calcula quantos ficam em pé
  const quantidadeEmPe = total - lugaresDisponiveis;

  // Seleciona quem fica em pé usando o ponteiro (rodízio A-Z)
  const emPe = [];
  for (let i = 0; i < quantidadeEmPe; i++) {
    const idx = (ponteiroEmPe + i) % total;
    emPe.push(participantesAZ[idx]);
  }

  // Quem não está em pé, senta
  const emPeIds = new Set(emPe.map(p => p.id));
  const sentadosRodizio = participantesRodizio.filter(p => !emPeIds.has(p.id));

  // Sentados = cadeiras fixas + sentados do rodízio
  const sentados = [...cadeirasFixas, ...sentadosRodizio];

  // Bancos traseiros só para quem participa do rodízio (sentados, não em pé)
  const bancosTraseiros = await calcularBancosTraseiros(sentadosRodizio, ponteiroBancos, totalPresentes);

  return { sentados, emPe, bancosTraseiros, cadeirasFixas };
}

/**
 * Calcula assentos completo para IDA e VOLTA separadamente.
 * 
 * REGRA IMPORTANTE: 
 * - Usa o MESMO ponteiro para ida e volta (tanto em pé quanto bancos traseiros)
 * - A volta continua de onde a ida parou
 * - Quem ficou em pé na IDA é pulado na VOLTA
 * - Quem foi para banco traseiro na IDA é pulado na VOLTA
 * 
 * @param {Array} respostasComCadeiraFixa - Lista de respostas com informação de cadeira_fixa
 * @returns {Object} { ida: {...}, volta: {...} }
 */
async function calcularAssentosIdaVolta(respostasComCadeiraFixa) {
  // Filtra quem vai na IDA: vou_e_volto ou so_vou
  const presentesIda = respostasComCadeiraFixa.filter(r => 
    r.resposta === 'vou_e_volto' || r.resposta === 'so_vou'
  );
  
  // Filtra quem vai na VOLTA: vou_e_volto ou so_volto
  const presentesVolta = respostasComCadeiraFixa.filter(r => 
    r.resposta === 'vou_e_volto' || r.resposta === 'so_volto'
  );

  // ========== CÁLCULO DA IDA ==========
  const resultadoIda = await calcularAssentosTrechoComPonteiro(
    presentesIda, 
    1, 
    [], // Sem exclusões de em pé
    0,  // Sem offset de em pé
    [], // Sem exclusões de bancos traseiros
    0   // Sem offset de bancos traseiros
  );

  // ========== CÁLCULO DA VOLTA ==========
  // Quem ficou em pé na IDA deve ser pulado na VOLTA
  // Quem foi para banco traseiro na IDA deve ser pulado na VOLTA
  // Continua do ponteiro onde a ida parou
  const resultadoVolta = await calcularAssentosTrechoComPonteiro(
    presentesVolta, 
    1, // Usa o MESMO ponteiro (ida)
    resultadoIda.emPe, // Pula quem já ficou em pé na ida
    resultadoIda.emPe.length, // Offset em pé: continua de onde a ida parou
    resultadoIda.bancosTraseiros, // Pula quem já foi para banco traseiro na ida
    resultadoIda.bancosTraseiros.length // Offset bancos: continua de onde a ida parou
  );

  return {
    ida: {
      ...resultadoIda,
      totalPresentes: presentesIda.length
    },
    volta: {
      ...resultadoVolta,
      totalPresentes: presentesVolta.length
    }
  };
}

/**
 * Calcula os assentos de um trecho considerando exclusões e offset do ponteiro.
 * 
 * @param {Array} presentes - Lista de passageiros presentes no trecho
 * @param {number} tipoRodizio - ID do ponteiro no banco (1 = ponteiro único)
 * @param {Array} excluirDoRodizioEmPe - Passageiros que devem ser pulados do rodízio em pé
 * @param {number} offsetPonteiroEmPe - Quanto avançar além do ponteiro de em pé
 * @param {Array} excluirDoRodizioBancos - Passageiros que devem ser pulados do rodízio de bancos
 * @param {number} offsetPonteiroBancos - Quanto avançar além do ponteiro de bancos
 */
async function calcularAssentosTrechoComPonteiro(presentes, tipoRodizio, excluirDoRodizioEmPe, offsetPonteiroEmPe, excluirDoRodizioBancos = [], offsetPonteiroBancos = 0) {
  if (presentes.length === 0) {
    return { sentados: [], emPe: [], bancosTraseiros: [], cadeirasFixas: [] };
  }

  // Separa passageiros com cadeira fixa dos demais
  const cadeirasFixas = presentes.filter(p => p.cadeira_fixa === 1);
  const participantesRodizio = presentes.filter(p => p.cadeira_fixa !== 1);

  const totalPresentes = presentes.length;
  const limiteSentados = await getLimiteSentados();
  const lugaresDisponiveis = limiteSentados - cadeirasFixas.length;

  // Caso todos caibam sentados
  if (participantesRodizio.length <= lugaresDisponiveis) {
    const sentados = [...cadeirasFixas, ...participantesRodizio];
    let bancosTraseiros = [];
    
    if (totalPresentes > LIMITE_PARA_BANCOS_TRASEIROS && participantesRodizio.length > 0) {
      const ponteiroBancos = (await db.execute({ sql: 'SELECT ponteiro FROM rotacao_bancos_traseiros WHERE id = ?', args: [tipoRodizio] })).rows[0].ponteiro;
      bancosTraseiros = await calcularBancosTraseirosComExclusao(
        participantesRodizio, 
        ponteiroBancos, 
        totalPresentes, 
        excluirDoRodizioBancos, 
        offsetPonteiroBancos
      );
    }
    return { sentados, emPe: [], bancosTraseiros, cadeirasFixas };
  }

  // IDs dos que devem ser pulados (já ficaram em pé no outro trecho)
  const excluirIdsEmPe = new Set(excluirDoRodizioEmPe.map(p => p.id));

  // Calcula quantos ficam em pé
  const quantidadeEmPe = participantesRodizio.length - lugaresDisponiveis;

  // Busca ponteiro de rodízio
  const ponteiroBaseEmPe = (await db.execute({ sql: 'SELECT ponteiro FROM rotacao_assentos WHERE id = ?', args: [tipoRodizio] })).rows[0].ponteiro;
  const ponteiroBaseBancos = (await db.execute({ sql: 'SELECT ponteiro FROM rotacao_bancos_traseiros WHERE id = ?', args: [tipoRodizio] })).rows[0].ponteiro;

  // Ordena TODOS os participantes A-Z (lista completa para manter ordem consistente)
  const todosSortedAZ = [...participantesRodizio].sort((a, b) => a.nome.localeCompare(b.nome));
  const totalParticipantes = todosSortedAZ.length;

  // Ponteiro inicial considerando o offset (para volta continuar de onde ida parou)
  const ponteiroInicialEmPe = (ponteiroBaseEmPe + offsetPonteiroEmPe) % totalParticipantes;

  // Seleciona quem fica em pé, pulando os excluídos
  const emPe = [];
  let posicao = ponteiroInicialEmPe;
  let tentativas = 0;
  
  while (emPe.length < quantidadeEmPe && tentativas < totalParticipantes) {
    const candidato = todosSortedAZ[posicao % totalParticipantes];
    
    // Se não está na lista de exclusão, adiciona aos em pé
    if (!excluirIdsEmPe.has(candidato.id)) {
      emPe.push(candidato);
    }
    
    posicao++;
    tentativas++;
  }

  // Quem não está em pé, senta
  const emPeIds = new Set(emPe.map(p => p.id));
  const sentadosRodizio = participantesRodizio.filter(p => !emPeIds.has(p.id));

  // Sentados = cadeiras fixas + sentados do rodízio
  const sentados = [...cadeirasFixas, ...sentadosRodizio];

  // Bancos traseiros só para quem participa do rodízio (sentados, não em pé)
  const bancosTraseiros = await calcularBancosTraseirosComExclusao(
    sentadosRodizio, 
    ponteiroBaseBancos, 
    totalPresentes, 
    excluirDoRodizioBancos, 
    offsetPonteiroBancos
  );

  return { sentados, emPe, bancosTraseiros, cadeirasFixas };
}

/**
 * Seleciona passageiros sentados para os bancos traseiros usando o ponteiro.
 * Quantidade proporcional: 19 pessoas = 1 banco, 20 = 2, ..., 23+ = 5
 * Ordenação: Z-A (decrescente por nome)
 * 
 * @param {Array} sentados - Lista de sentados elegíveis para banco traseiro
 * @param {number} ponteiro - Ponteiro base do rodízio
 * @param {number} totalPresentes - Total de presentes para calcular quantos bancos
 * @param {Array} excluir - Passageiros que devem ser pulados (já foram na ida)
 * @param {number} offset - Quanto avançar além do ponteiro (para volta continuar da ida)
 */
async function calcularBancosTraseirosComExclusao(sentados, ponteiro, totalPresentes, excluir = [], offset = 0) {
  if (sentados.length === 0) return [];
  
  const bancosTraseiros = await getBancosTraseiros();
  
  // Quantidade de bancos traseiros = passageiros acima de 18 (máximo 5)
  const bancosNecessarios = Math.max(0, totalPresentes - LIMITE_PARA_BANCOS_TRASEIROS);
  const quantidade = Math.min(bancosTraseiros, bancosNecessarios, sentados.length);
  
  if (quantidade === 0) return [];
  
  // Ordena Z-A (decrescente por nome) para rodízio
  const sentadosOrdenados = [...sentados].sort((a, b) => b.nome.localeCompare(a.nome));
  const total = sentadosOrdenados.length;
  
  // IDs dos que devem ser pulados (já foram para banco traseiro na ida)
  const excluirIds = new Set(excluir.map(p => p.id));
  
  // Ponteiro inicial considerando o offset
  const ponteiroInicial = (ponteiro + offset) % total;
  
  const resultado = [];
  let posicao = ponteiroInicial;
  let tentativas = 0;
  
  while (resultado.length < quantidade && tentativas < total) {
    const candidato = sentadosOrdenados[posicao % total];
    
    // Se não está na lista de exclusão, adiciona
    if (!excluirIds.has(candidato.id)) {
      resultado.push(candidato);
    }
    
    posicao++;
    tentativas++;
  }
  
  return resultado;
}

// Função legada mantida para compatibilidade
async function calcularBancosTraseiros(sentados, ponteiro, totalPresentes) {
  return await calcularBancosTraseirosComExclusao(sentados, ponteiro, totalPresentes, [], 0);
}

/**
 * Avança o ponteiro de rodízio de Em Pé para o próximo dia.
 * O ponteiro indica quem fica em pé (rodízio A-Z).
 * Avança pela quantidade de pessoas que ficaram em pé.
 * @param {number} tipoRodizio - 1 para IDA, 2 para VOLTA
 */
async function avancarPonteiroAssentos(participantesRodizio, quantidadeEmPe, tipoRodizio = 1) {
  if (quantidadeEmPe === 0 || participantesRodizio.length === 0) {
    // Ninguém em pé, ponteiro não muda
    return;
  }
  const ponteiroAtual = (await db.execute({ sql: 'SELECT ponteiro FROM rotacao_assentos WHERE id = ?', args: [tipoRodizio] })).rows[0].ponteiro;
  const novoPonteiro = (ponteiroAtual + quantidadeEmPe) % participantesRodizio.length;
  await db.execute({ sql: 'UPDATE rotacao_assentos SET ponteiro = ? WHERE id = ?', args: [novoPonteiro, tipoRodizio] });
}

/**
 * Avança o ponteiro de rodízio dos bancos traseiros.
 * @param {Array} sentados - Lista de sentados que participam do rodízio
 * @param {number} quantidade - Quantidade de bancos traseiros utilizados (ida + volta)
 * @param {number} tipoRodizio - 1 para IDA, 2 para VOLTA
 */
async function avancarPonteiroBancos(sentados, quantidade, tipoRodizio = 1) {
  const total = sentados.length;
  if (total === 0 || quantidade === 0) return;
  const ponteiroAtual = (await db.execute({ sql: 'SELECT ponteiro FROM rotacao_bancos_traseiros WHERE id = ?', args: [tipoRodizio] })).rows[0].ponteiro;
  const novoPonteiro = (ponteiroAtual + quantidade) % total;
  await db.execute({ sql: 'UPDATE rotacao_bancos_traseiros SET ponteiro = ? WHERE id = ?', args: [novoPonteiro, tipoRodizio] });
}

/**
 * Gera e salva o relatório do dia no banco.
 * Também avança os ponteiros para o próximo dia (ida e volta separadamente).
 * Remove relatórios com mais de 30 dias.
 */
async function gerarRelatorioDoDia(data) {
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

  // Busca informação de cadeira_fixa para respostas
  const respostasComCadeira = await Promise.all(respostas.map(async r => {
    const passageiro = (await db.execute({ sql: 'SELECT cadeira_fixa FROM passageiros WHERE id = ?', args: [r.id] })).rows[0];
    return { ...r, cadeira_fixa: passageiro?.cadeira_fixa || 0 };
  }));

  // Calcula ida e volta separadamente
  const { ida, volta } = await calcularAssentosIdaVolta(respostasComCadeira);

  // Calcula participantes do rodízio (sem cadeira fixa) para IDA
  const presentesIda = respostasComCadeira.filter(r => 
    r.resposta === 'vou_e_volto' || r.resposta === 'so_vou'
  );
  const participantesRodizioIda = presentesIda.filter(r => r.cadeira_fixa !== 1);

  // Avança ponteiro único pela quantidade total de pessoas em pé (ida + volta)
  // Isso mantém a ordem A-Z contínua entre os dias
  const totalEmPe = ida.emPe.length + volta.emPe.length;
  await avancarPonteiroAssentos(participantesRodizioIda, totalEmPe, 1);
  
  // Avança ponteiro dos bancos traseiros pelo total (ida + volta)
  // Isso mantém a ordem Z-A contínua entre os dias
  const totalBancosTraseiros = ida.bancosTraseiros.length + volta.bancosTraseiros.length;
  await avancarPonteiroBancos(ida.sentados.filter(s => s.cadeira_fixa !== 1), totalBancosTraseiros, 1);

  const dadosJson = JSON.stringify({
    passageiros: respostas.map(r => ({ id: r.id, nome: r.nome, ordem: r.ordem, resposta: r.resposta })),
    ida: {
      sentados: ida.sentados.map(p => ({ id: p.id, nome: p.nome })),
      emPe: ida.emPe.map(p => ({ id: p.id, nome: p.nome })),
      bancosTraseiros: ida.bancosTraseiros.map(p => ({ id: p.id, nome: p.nome })),
      totalPresentes: ida.totalPresentes
    },
    volta: {
      sentados: volta.sentados.map(p => ({ id: p.id, nome: p.nome })),
      emPe: volta.emPe.map(p => ({ id: p.id, nome: p.nome })),
      bancosTraseiros: volta.bancosTraseiros.map(p => ({ id: p.id, nome: p.nome })),
      totalPresentes: volta.totalPresentes
    }
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
    ida.sentados.length + volta.sentados.length,
    ida.emPe.length + volta.emPe.length,
    dadosJson
  );

  // Remove relatórios com mais de 30 dias
  db.prepare(`
    DELETE FROM relatorios
    WHERE data < date('now', '-30 days')
  `).run();

  return { 
    totalPassageiros: respostas.length, 
    totalVouEVolto, 
    totalSoVou, 
    totalSoVolto, 
    ida, 
    volta 
  };
}

/**
 * Limpa as respostas da enquete do dia especificado.
 */
async function limparRespostasDia(data) {
  await db.execute({ sql: 'DELETE FROM respostas_dia WHERE data = ?', args: [data] });
}

// ─────────────────────────────────────────────
// Agendamento: gerar relatório às 15:30
// ─────────────────────────────────────────────
cron.schedule('30 15 * * *', async () => {
  const dataHoje = getDataHoje();
  console.log(`[CRON] Gerando relatório do dia ${dataHoje}...`);
  const resultado = await gerarRelatorioDoDia(dataHoje);
  if (resultado) {
    console.log(`[CRON] Relatório gerado: ${resultado.totalPassageiros} passageiros`);
  } else {
    console.log(`[CRON] Nenhuma resposta para gerar relatório`);
  }
});

// ─────────────────────────────────────────────
// Agendamento: limpar respostas antigas às 00:00
// ─────────────────────────────────────────────
cron.schedule('0 0 * * *', async () => {
  // Calcula a data de ontem
  const ontem = new Date();
  ontem.setDate(ontem.getDate() - 1);
  const dataOntem = `${ontem.getFullYear()}-${String(ontem.getMonth() + 1).padStart(2, '0')}-${String(ontem.getDate()).padStart(2, '0')}`;
  
  console.log(`[CRON] Limpando respostas do dia ${dataOntem}...`);
  await limparRespostasDia(dataOntem);
  console.log(`[CRON] Limpeza concluída`);
});

// ─────────────────────────────────────────────
// Rotas da API
// ─────────────────────────────────────────────

/**
 * POST /api/admin/login
 * Verifica a senha de administração
 * Body: { senha }
 */
app.post('/api/admin/login', limiteEscrita, async (req, res) => {
  const { senha } = req.body;
  
  if (senha === ADMIN_PASSWORD) {
    res.json({ sucesso: true });
  } else {
    res.status(401).json({ erro: 'Senha incorreta' });
  }
});

/**
 * GET /api/admin/configuracoes
 * Retorna as configurações do sistema
 */
app.get('/api/admin/configuracoes', async (req, res) => {
  const limiteSentados = await getLimiteSentados();
  const bancosTraseiros = await getBancosTraseiros();
  res.json({ limite_sentados: limiteSentados, bancos_traseiros: bancosTraseiros });
});

/**
 * PUT /api/admin/configuracoes
 * Atualiza configurações do sistema
 * Body: { limite_sentados, bancos_traseiros }
 */
app.put('/api/admin/configuracoes', limiteEscrita, async (req, res) => {
  const { limite_sentados, bancos_traseiros } = req.body;
  
  if (limite_sentados !== undefined) {
    const valorLimite = parseInt(limite_sentados);
    if (!isNaN(valorLimite) && valorLimite >= 1) {
      await db.execute({ sql: "INSERT INTO configuracoes (chave, valor) VALUES ('limite_sentados', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor", args: [valorLimite.toString()] });
    }
  }

  if (bancos_traseiros !== undefined) {
    const valorBancos = parseInt(bancos_traseiros);
    if (!isNaN(valorBancos) && valorBancos >= 0) {
      await db.execute({ sql: "INSERT INTO configuracoes (chave, valor) VALUES ('bancos_traseiros', ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor", args: [valorBancos.toString()] });
    }
  }
  
  res.json({ 
    sucesso: true, 
    configuracoes: { 
      limite_sentados: await getLimiteSentados(),
      bancos_traseiros: await getBancosTraseiros()
    } 
  });
});

/**
 * GET /api/admin/ponteiros
 * Retorna o estado dos ponteiros e o último passageiro de cada rodízio.
 */
app.get('/api/admin/ponteiros', async (req, res) => {
  const ponteiroAssentosRaw = (await db.execute('SELECT ponteiro FROM rotacao_assentos WHERE id = 1')).rows[0]?.ponteiro || 0;
  const ponteiroBancosRaw = (await db.execute('SELECT ponteiro FROM rotacao_bancos_traseiros WHERE id = 1')).rows[0]?.ponteiro || 0;

  const participantesRodizio = db.prepare(`
    SELECT id, nome
    FROM passageiros
    WHERE cadeira_fixa != 1
  `).all();

  const participantesAZ = [...participantesRodizio].sort((a, b) => a.nome.localeCompare(b.nome));
  const participantesZA = [...participantesRodizio].sort((a, b) => b.nome.localeCompare(a.nome));

  function montarInfoPonteiro(listaOrdenada, ponteiroRaw, ordem) {
    const total = listaOrdenada.length;
    if (total === 0) {
      return {
        ordem,
        totalParticipantes: 0,
        ponteiroAtual: 0,
        ultimo: null,
        proximo: null
      };
    }

    const ponteiroAtual = ((ponteiroRaw % total) + total) % total;
    const idxUltimo = (ponteiroAtual - 1 + total) % total;

    return {
      ordem,
      totalParticipantes: total,
      ponteiroAtual,
      ultimo: listaOrdenada[idxUltimo],
      proximo: listaOrdenada[ponteiroAtual]
    };
  }

  res.json({
    assentos: montarInfoPonteiro(participantesAZ, ponteiroAssentosRaw, 'A-Z'),
    bancosTraseiros: montarInfoPonteiro(participantesZA, ponteiroBancosRaw, 'Z-A')
  });
});

/**
 * PUT /api/admin/ponteiros/:tipo
 * Define manualmente a última pessoa de um rodízio
 * Params: tipo ('assentos' ou 'bancosTraseiros')
 * Body: { passageiro_id }
 */
app.put('/api/admin/ponteiros/:tipo', limiteEscrita, async (req, res) => {
  const { tipo } = req.params;
  const { passageiro_id } = req.body;

  if (tipo !== 'assentos' && tipo !== 'bancosTraseiros') {
    return res.status(400).json({ erro: 'Tipo de ponteiro inválido' });
  }

  // Verifica se o passageiro existe e não tem cadeira fixa
  const passageiro = (await db.execute({ sql: 'SELECT id, nome, cadeira_fixa FROM passageiros WHERE id = ?', args: [passageiro_id] })).rows[0];
  if (!passageiro) {
    return res.status(404).json({ erro: 'Passageiro não encontrado' });
  }
  if (passageiro.cadeira_fixa === 1) {
    return res.status(400).json({ erro: 'Passageiro com cadeira fixa não participa do rodízio' });
  }

  // Busca lista de participantes do rodízio
  const participantesRodizio = (await db.execute('SELECT id, nome FROM passageiros WHERE cadeira_fixa != 1')).rows;
  if (participantesRodizio.length === 0) {
    return res.status(400).json({ erro: 'Nenhum participante no rodízio' });
  }

  let index = -1;
  let tabela = '';
  
  if (tipo === 'assentos') {
    const participantesAZ = [...participantesRodizio].sort((a, b) => a.nome.localeCompare(b.nome));
    index = participantesAZ.findIndex(p => p.id === parseInt(passageiro_id));
    tabela = 'rotacao_assentos';
  } else {
    const participantesZA = [...participantesRodizio].sort((a, b) => b.nome.localeCompare(a.nome));
    index = participantesZA.findIndex(p => p.id === parseInt(passageiro_id));
    tabela = 'rotacao_bancos_traseiros';
  }

  if (index === -1) {
    return res.status(500).json({ erro: 'Passageiro não encontrado na lista ordenada' });
  }

  // O ponteiro aponta para o PRÓXIMO. Se o passageiro escolhido foi o ÚLTIMO, o próximo é (index + 1)
  const novoPonteiro = (index + 1) % participantesRodizio.length;

  // Atualiza no banco (atualiza tanto ida quanto volta)
  await db.execute({ sql: `UPDATE ${tabela} SET ponteiro = ? WHERE id = 1`, args: [novoPonteiro] });
  await db.execute({ sql: `UPDATE ${tabela} SET ponteiro = ? WHERE id = 2`, args: [novoPonteiro] });

  res.json({ sucesso: true, novoPonteiro, ultimoPassageiro: passageiro.nome });
});

/**
 * GET /api/passageiros
 * Retorna lista de todos os passageiros em ordem alfabética
 */
app.get('/api/passageiros', async (req, res) => {
  const passageiros = (await db.execute('SELECT id, nome, ordem, cadeira_fixa FROM passageiros ORDER BY ordem')).rows;
  res.json(passageiros);
});

/**
 * POST /api/passageiros
 * Adiciona um novo passageiro
 * Body: { nome }
 */
app.post('/api/passageiros', limiteEscrita, async (req, res) => {
  const { nome } = req.body;

  if (!nome || nome.trim() === '') {
    return res.status(400).json({ erro: 'Nome é obrigatório' });
  }

  const nomeNormalizado = nome.trim();

  // Verifica se já existe
  const existente = (await db.execute({ sql: 'SELECT id FROM passageiros WHERE nome = ?', args: [nomeNormalizado] })).rows[0];
  if (existente) {
    return res.status(409).json({ erro: 'Passageiro já existe na lista' });
  }

  // Pega a última ordem e adiciona +1
  const ultimaOrdem = (await db.execute('SELECT MAX(ordem) as max FROM passageiros')).rows[0];
  const novaOrdem = (ultimaOrdem.max || 0) + 1;

  const result = await db.execute({ sql: 'INSERT INTO passageiros (nome, ordem) VALUES (?, ?)', args: [nomeNormalizado, novaOrdem] });
  
  res.json({ sucesso: true, id: result.lastInsertRowid, nome: nomeNormalizado, ordem: novaOrdem });
});

/**
 * PUT /api/passageiros/:id
 * Edita um passageiro (nome e/ou cadeira_fixa)
 * Body: { nome?, cadeira_fixa? }
 */
app.put('/api/passageiros/:id', limiteEscrita, async (req, res) => {
  const { id } = req.params;
  const { nome, cadeira_fixa } = req.body;

  // Verifica se o passageiro existe
  const passageiro = (await db.execute({ sql: 'SELECT id, nome, cadeira_fixa FROM passageiros WHERE id = ?', args: [id] })).rows[0];
  if (!passageiro) {
    return res.status(404).json({ erro: 'Passageiro não encontrado' });
  }

  // Atualiza nome se fornecido
  if (nome !== undefined && nome.trim() !== '') {
    const nomeNormalizado = nome.trim();
    // Verifica se outro passageiro já tem esse nome
    const existente = (await db.execute({ sql: 'SELECT id FROM passageiros WHERE nome = ? AND id != ?', args: [nomeNormalizado, id] })).rows[0];
    if (existente) {
      return res.status(409).json({ erro: 'Já existe outro passageiro com esse nome' });
    }
    await db.execute({ sql: 'UPDATE passageiros SET nome = ? WHERE id = ?', args: [nomeNormalizado, id] });
  }

  // Atualiza cadeira_fixa se fornecido
  if (cadeira_fixa !== undefined) {
    const valor = cadeira_fixa ? 1 : 0;
    await db.execute({ sql: 'UPDATE passageiros SET cadeira_fixa = ? WHERE id = ?', args: [valor, id] });
  }

  // Retorna passageiro atualizado
  const atualizado = (await db.execute({ sql: 'SELECT id, nome, ordem, cadeira_fixa FROM passageiros WHERE id = ?', args: [id] })).rows[0];
  res.json({ sucesso: true, passageiro: atualizado });
});

/**
 * DELETE /api/passageiros/:id
 * Remove um passageiro da lista
 */
app.delete('/api/passageiros/:id', limiteEscrita, async (req, res) => {
  const { id } = req.params;

  // Verifica se o passageiro existe
  const passageiro = (await db.execute({ sql: 'SELECT id, nome FROM passageiros WHERE id = ?', args: [id] })).rows[0];
  if (!passageiro) {
    return res.status(404).json({ erro: 'Passageiro não encontrado' });
  }

  // Remove respostas do dia associadas
  await db.execute({ sql: 'DELETE FROM respostas_dia WHERE passageiro_id = ?', args: [id] });
  
  // Remove o passageiro
  await db.execute({ sql: 'DELETE FROM passageiros WHERE id = ?', args: [id] });

  // Reordena os passageiros restantes
  const passageiros = (await db.execute('SELECT id FROM passageiros ORDER BY ordem')).rows;
  for (let i = 0; i < passageiros.length; i++) {
    await db.execute({ sql: 'UPDATE passageiros SET ordem = ? WHERE id = ?', args: [i + 1, passageiros[i].id] });
  }

  res.json({ sucesso: true, removido: passageiro.nome });
});

/**
 * GET /api/respostas
 * Retorna as respostas de hoje com dados calculados separados para IDA e VOLTA
 */
app.get('/api/respostas', async (req, res) => {
  const data = getDataHoje();

  const respostas = db.prepare(`
    SELECT p.id, p.nome, p.ordem, r.resposta
    FROM respostas_dia r
    JOIN passageiros p ON p.id = r.passageiro_id
    WHERE r.data = ?
    ORDER BY p.ordem
  `).all(data);

  // Busca informação de cadeira_fixa para cada passageiro
  const passageirosInfo = (await db.execute('SELECT id, cadeira_fixa FROM passageiros')).rows;
  const mapaCadeiraFixa = {};
  passageirosInfo.forEach(p => { mapaCadeiraFixa[p.id] = p.cadeira_fixa; });

  // Adiciona cadeira_fixa às respostas
  const respostasComCadeiraFixa = respostas.map(r => ({
    ...r,
    cadeira_fixa: mapaCadeiraFixa[r.id] || 0
  }));

  // Mapa de id -> resposta para fácil consulta no frontend
  const mapaRespostas = {};
  respostas.forEach(r => { mapaRespostas[r.id] = r.resposta; });

  // Calcula ida e volta separadamente
  const { ida, volta } = await calcularAssentosIdaVolta(respostasComCadeiraFixa);

  res.json({
    data,
    podeVotar: podeVotar(),
    respostas: mapaRespostas,
    resumo: {
      totalPassageiros: respostas.length,
      // Resumo IDA
      totalPresentesIda: ida.totalPresentes,
      totalSentadosIda: ida.sentados.length,
      totalEmPeIda: ida.emPe.length,
      // Resumo VOLTA
      totalPresentesVolta: volta.totalPresentes,
      totalSentadosVolta: volta.sentados.length,
      totalEmPeVolta: volta.emPe.length
    },
    ida: {
      sentados: ida.sentados.map(p => ({ id: p.id, nome: p.nome, cadeira_fixa: p.cadeira_fixa })),
      emPe: ida.emPe.map(p => ({ id: p.id, nome: p.nome })),
      bancosTraseiros: ida.bancosTraseiros.map(p => ({ id: p.id, nome: p.nome })),
      cadeirasFixas: ida.cadeirasFixas.map(p => ({ id: p.id, nome: p.nome }))
    },
    volta: {
      sentados: volta.sentados.map(p => ({ id: p.id, nome: p.nome, cadeira_fixa: p.cadeira_fixa })),
      emPe: volta.emPe.map(p => ({ id: p.id, nome: p.nome })),
      bancosTraseiros: volta.bancosTraseiros.map(p => ({ id: p.id, nome: p.nome })),
      cadeirasFixas: volta.cadeirasFixas.map(p => ({ id: p.id, nome: p.nome }))
    }
  });
});

/**
 * POST /api/respostas
 * Salva ou atualiza a resposta de um passageiro
 * Body: { passageiro_id, resposta }
 */
app.post('/api/respostas', limiteEscrita, async (req, res) => {
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
  const passageiro = (await db.execute({ sql: 'SELECT id FROM passageiros WHERE id = ?', args: [passageiro_id] })).rows[0];
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
app.delete('/api/respostas/:passageiro_id', limiteEscrita, async (req, res) => {
  // Verifica se ainda está no horário permitido para votar
  if (!podeVotar()) {
    return res.status(403).json({ erro: 'Votação encerrada. Não é possível alterar após 15:30.' });
  }

  const { passageiro_id } = req.params;
  const data = getDataHoje();
  await db.execute({ sql: 'DELETE FROM respostas_dia WHERE passageiro_id = ? AND data = ?', args: [passageiro_id, data] });
  res.json({ sucesso: true });
});

/**
 * GET /api/relatorios
 * Lista todos os relatórios salvos (últimos 30 dias)
 */
app.get('/api/relatorios', async (req, res) => {
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
app.get('/api/relatorios/:data', async (req, res) => {
  const { data } = req.params;
  const relatorio = (await db.execute({ sql: 'SELECT * FROM relatorios WHERE data = ?', args: [data] })).rows[0];
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
app.post('/api/relatorios/gerar', limiteEscrita, async (req, res) => {
  const data = getDataHoje();
  const resultado = await gerarRelatorioDoDia(data);
  if (!resultado) {
    return res.status(400).json({ erro: 'Nenhuma resposta encontrada para hoje' });
  }
  res.json({ sucesso: true, data, ...resultado });
});

/**
 * GET /api/relatorio/csv
 * Exporta o relatório de HOJE como CSV (atalho) - com IDA e VOLTA separados
 */
app.get('/api/relatorio/csv', async (req, res) => {
  const data = getDataHoje();
  
  // Busca respostas do dia
  const respostas = db.prepare(`
    SELECT p.id, p.nome, p.ordem, r.resposta
    FROM respostas_dia r
    JOIN passageiros p ON p.id = r.passageiro_id
    WHERE r.data = ?
    ORDER BY p.ordem
  `).all(data);

  if (respostas.length === 0) {
    return res.status(404).send('Nenhuma resposta registrada hoje.');
  }

  // Busca informação de cadeira_fixa
  const passageirosInfo = (await db.execute('SELECT id, cadeira_fixa FROM passageiros')).rows;
  const mapaCadeiraFixa = {};
  passageirosInfo.forEach(p => { mapaCadeiraFixa[p.id] = p.cadeira_fixa; });

  // Adiciona cadeira_fixa às respostas
  const respostasComCadeiraFixa = respostas.map(r => ({
    ...r,
    cadeira_fixa: mapaCadeiraFixa[r.id] || 0
  }));

  // Calcula assentos separados para ida e volta
  const { ida, volta } = await calcularAssentosIdaVolta(respostasComCadeiraFixa);

  // Separa por tipo de resposta
  const vouEVolto = respostas.filter(r => r.resposta === 'vou_e_volto').map(r => r.nome);
  const soVou = respostas.filter(r => r.resposta === 'so_vou').map(r => r.nome);
  const soVolto = respostas.filter(r => r.resposta === 'so_volto').map(r => r.nome);

  const totalPassageiros = respostas.length;
  const maxLinhas = Math.max(vouEVolto.length, soVou.length, soVolto.length);

  let csv = `Relatório de Presença - ${data}\n`;
  csv += `Total de passageiros: ${totalPassageiros}\n\n`;
  csv += 'Vai e Volta;Só Vai;Só Volta\n';

  for (let i = 0; i < maxLinhas; i++) {
    const col1 = vouEVolto[i] || '';
    const col2 = soVou[i] || '';
    const col3 = soVolto[i] || '';
    csv += `${col1};${col2};${col3}\n`;
  }

  // Seção: IDA
  csv += `\n========== IDA (${ida.totalPresentes} pessoas) ==========\n`;
  
  if (ida.emPe.length > 0) {
    csv += `\nEm Pé na IDA (${ida.emPe.length} pessoa${ida.emPe.length > 1 ? 's' : ''})\n`;
    ida.emPe.forEach((p, i) => {
      csv += `${i + 1}. ${p.nome}\n`;
    });
  }

  if (ida.bancosTraseiros.length > 0) {
    csv += `\nBancos Traseiros na IDA (${ida.bancosTraseiros.length})\n`;
    ida.bancosTraseiros.forEach((p, i) => {
      csv += `${i + 1}. ${p.nome}\n`;
    });
  }

  // Seção: VOLTA
  csv += `\n========== VOLTA (${volta.totalPresentes} pessoas) ==========\n`;
  
  if (volta.emPe.length > 0) {
    csv += `\nEm Pé na VOLTA (${volta.emPe.length} pessoa${volta.emPe.length > 1 ? 's' : ''})\n`;
    volta.emPe.forEach((p, i) => {
      csv += `${i + 1}. ${p.nome}\n`;
    });
  }

  if (volta.bancosTraseiros.length > 0) {
    csv += `\nBancos Traseiros na VOLTA (${volta.bancosTraseiros.length})\n`;
    volta.bancosTraseiros.forEach((p, i) => {
      csv += `${i + 1}. ${p.nome}\n`;
    });
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="relatorio-${data}.csv"`);
  res.send('\uFEFF' + csv);
});

/**
 * GET /api/relatorio/pdf
 * Exporta o relatório de HOJE como PDF (atalho) - com IDA e VOLTA separados
 */
app.get('/api/relatorio/pdf', async (req, res) => {
  const data = getDataHoje();

  // Busca respostas do dia
  const respostas = db.prepare(`
    SELECT p.id, p.nome, p.ordem, r.resposta
    FROM respostas_dia r
    JOIN passageiros p ON p.id = r.passageiro_id
    WHERE r.data = ?
    ORDER BY p.ordem
  `).all(data);

  if (respostas.length === 0) {
    return res.status(404).send('Nenhuma resposta registrada hoje.');
  }

  // Busca informação de cadeira_fixa
  const passageirosInfo = (await db.execute('SELECT id, cadeira_fixa FROM passageiros')).rows;
  const mapaCadeiraFixa = {};
  passageirosInfo.forEach(p => { mapaCadeiraFixa[p.id] = p.cadeira_fixa; });

  // Adiciona cadeira_fixa às respostas
  const respostasComCadeiraFixa = respostas.map(r => ({
    ...r,
    cadeira_fixa: mapaCadeiraFixa[r.id] || 0
  }));

  // Calcula assentos separados para ida e volta
  const { ida, volta } = await calcularAssentosIdaVolta(respostasComCadeiraFixa);

  // Separa por tipo
  const vouEVolto = respostas.filter(r => r.resposta === 'vou_e_volto').map(r => r.nome);
  const soVou = respostas.filter(r => r.resposta === 'so_vou').map(r => r.nome);
  const soVolto = respostas.filter(r => r.resposta === 'so_volto').map(r => r.nome);

  const totalPassageiros = respostas.length;
  const maxLinhas = Math.max(vouEVolto.length, soVou.length, soVolto.length);

  // Cria PDF
  const doc = new PDFDocument({ size: 'A4', margin: 40 });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="relatorio-${data}.pdf"`);
  doc.pipe(res);

  // Título
  doc.fontSize(18).font('Helvetica-Bold').text(`Relatório de Presença`, { align: 'center' });
  doc.fontSize(12).font('Helvetica').text(`Data: ${data}`, { align: 'center' });
  doc.fontSize(10).text(`Total de passageiros: ${totalPassageiros}`, { align: 'center' });
  doc.moveDown(1.5);

  // Tabela de presenças
  const startX = 40;
  const colWidth = 175;
  const rowHeight = 18;
  let y = doc.y;

  // Cabeçalho
  doc.fontSize(10).font('Helvetica-Bold');
  doc.rect(startX, y, colWidth * 3, rowHeight).fillAndStroke('#e5e7eb', '#000');
  doc.fillColor('#000')
     .text('Vai e Volta', startX + 5, y + 4, { width: colWidth - 10 })
     .text('Só Vai', startX + colWidth + 5, y + 4, { width: colWidth - 10 })
     .text('Só Volta', startX + colWidth * 2 + 5, y + 4, { width: colWidth - 10 });
  y += rowHeight;

  // Linhas
  doc.font('Helvetica').fontSize(9);
  for (let i = 0; i < maxLinhas; i++) {
    const bg = i % 2 === 0 ? '#ffffff' : '#f9fafb';
    doc.rect(startX, y, colWidth * 3, rowHeight).fillAndStroke(bg, '#e5e7eb');
    doc.fillColor('#000')
       .text(vouEVolto[i] || '', startX + 5, y + 4, { width: colWidth - 10 })
       .text(soVou[i] || '', startX + colWidth + 5, y + 4, { width: colWidth - 10 })
       .text(soVolto[i] || '', startX + colWidth * 2 + 5, y + 4, { width: colWidth - 10 });
    y += rowHeight;

    if (y > 750) {
      doc.addPage();
      y = 40;
    }
  }

  // ========== SEÇÃO IDA ==========
  y += 25;
  if (y > 700) { doc.addPage(); y = 40; }
  
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#1a56db')
     .text(`IDA (${ida.totalPresentes} pessoas)`, startX, y);
  y += 25;

  // Em Pé - IDA
  if (ida.emPe.length > 0) {
    if (y > 700) { doc.addPage(); y = 40; }
    
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#c81e1e')
       .text(`Em Pé na IDA (${ida.emPe.length} pessoa${ida.emPe.length > 1 ? 's' : ''})`, startX, y);
    y += 18;
    
    doc.fontSize(9).font('Helvetica').fillColor('#000');
    ida.emPe.forEach((p, i) => {
      if (y > 750) { doc.addPage(); y = 40; }
      doc.text(`${i + 1}. ${p.nome}`, startX + 10, y);
      y += 14;
    });
    y += 10;
  }

  // Bancos Traseiros - IDA
  if (ida.bancosTraseiros.length > 0) {
    if (y > 700) { doc.addPage(); y = 40; }
    
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#c27803')
       .text(`Bancos Traseiros na IDA (${ida.bancosTraseiros.length})`, startX, y);
    y += 18;
    
    doc.fontSize(9).font('Helvetica').fillColor('#000');
    ida.bancosTraseiros.forEach((p, i) => {
      if (y > 750) { doc.addPage(); y = 40; }
      doc.text(`${i + 1}. ${p.nome}`, startX + 10, y);
      y += 14;
    });
    y += 10;
  }

  // ========== SEÇÃO VOLTA ==========
  y += 15;
  if (y > 700) { doc.addPage(); y = 40; }
  
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#057a55')
     .text(`VOLTA (${volta.totalPresentes} pessoas)`, startX, y);
  y += 25;

  // Em Pé - VOLTA
  if (volta.emPe.length > 0) {
    if (y > 700) { doc.addPage(); y = 40; }
    
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#c81e1e')
       .text(`Em Pé na VOLTA (${volta.emPe.length} pessoa${volta.emPe.length > 1 ? 's' : ''})`, startX, y);
    y += 18;
    
    doc.fontSize(9).font('Helvetica').fillColor('#000');
    volta.emPe.forEach((p, i) => {
      if (y > 750) { doc.addPage(); y = 40; }
      doc.text(`${i + 1}. ${p.nome}`, startX + 10, y);
      y += 14;
    });
    y += 10;
  }

  // Bancos Traseiros - VOLTA
  if (volta.bancosTraseiros.length > 0) {
    if (y > 700) { doc.addPage(); y = 40; }
    
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#c27803')
       .text(`Bancos Traseiros na VOLTA (${volta.bancosTraseiros.length})`, startX, y);
    y += 18;
    
    doc.fontSize(9).font('Helvetica').fillColor('#000');
    volta.bancosTraseiros.forEach((p, i) => {
      if (y > 750) { doc.addPage(); y = 40; }
      doc.text(`${i + 1}. ${p.nome}`, startX + 10, y);
      y += 14;
    });
  }

  doc.end();
});

/**
 * GET /api/relatorios/:data/csv
 * Exporta o relatório de uma data como CSV (formato 3 colunas) - com IDA e VOLTA separados
 */
app.get('/api/relatorios/:data/csv', async (req, res) => {
  const { data } = req.params;
  const relatorio = (await db.execute({ sql: 'SELECT * FROM relatorios WHERE data = ?', args: [data] })).rows[0];
  if (!relatorio) {
    return res.status(404).json({ erro: 'Relatório não encontrado' });
  }

  const dados = JSON.parse(relatorio.dados_json);
  const linhas = [];

  // Cabeçalho com contagem
  linhas.push(`"Relatório do Ônibus - ${data}"`);
  linhas.push(`"Total de pessoas no dia:","${relatorio.total_passageiros}"`);
  linhas.push(`"Vou e Volto:","${relatorio.total_vou_e_volto}","Só Vou:","${relatorio.total_so_vou}","Só Volto:","${relatorio.total_so_volto}"`);
  linhas.push('');

  // Separa por tipo de resposta
  const vouEVolto = dados.passageiros.filter(p => p.resposta === 'vou_e_volto').map(p => p.nome);
  const soVou = dados.passageiros.filter(p => p.resposta === 'so_vou').map(p => p.nome);
  const soVolto = dados.passageiros.filter(p => p.resposta === 'so_volto').map(p => p.nome);

  // Encontra o maior número de linhas
  const maxLinhas = Math.max(vouEVolto.length, soVou.length, soVolto.length);

  // Cabeçalho da tabela de 3 colunas
  linhas.push('"Vai e volta:","Só vai:","Só volta:"');

  // Preenche as linhas
  for (let i = 0; i < maxLinhas; i++) {
    const col1 = vouEVolto[i] || '';
    const col2 = soVou[i] || '';
    const col3 = soVolto[i] || '';
    linhas.push(`"${col1}","${col2}","${col3}"`);
  }

  linhas.push('');

  // Verifica se é formato novo (com ida/volta) ou antigo
  if (dados.ida && dados.volta) {
    // Formato novo: IDA e VOLTA separados
    linhas.push(`"========== IDA (${dados.ida.totalPresentes || dados.ida.sentados.length} pessoas) =========="`);
    
    if (dados.ida.emPe && dados.ida.emPe.length > 0) {
      linhas.push(`"Em Pé na IDA (${dados.ida.emPe.length}):"`);
      dados.ida.emPe.forEach((p, i) => linhas.push(`"${i + 1}. ${p.nome}"`));
      linhas.push('');
    }

    if (dados.ida.bancosTraseiros && dados.ida.bancosTraseiros.length > 0) {
      linhas.push(`"Bancos Traseiros na IDA (${dados.ida.bancosTraseiros.length}):"`);
      dados.ida.bancosTraseiros.forEach((p, i) => linhas.push(`"${i + 1}. ${p.nome}"`));
      linhas.push('');
    }

    linhas.push(`"========== VOLTA (${dados.volta.totalPresentes || dados.volta.sentados.length} pessoas) =========="`);
    
    if (dados.volta.emPe && dados.volta.emPe.length > 0) {
      linhas.push(`"Em Pé na VOLTA (${dados.volta.emPe.length}):"`);
      dados.volta.emPe.forEach((p, i) => linhas.push(`"${i + 1}. ${p.nome}"`));
      linhas.push('');
    }

    if (dados.volta.bancosTraseiros && dados.volta.bancosTraseiros.length > 0) {
      linhas.push(`"Bancos Traseiros na VOLTA (${dados.volta.bancosTraseiros.length}):"`);
      dados.volta.bancosTraseiros.forEach((p, i) => linhas.push(`"${i + 1}. ${p.nome}"`));
    }
  } else {
    // Formato antigo: compatibilidade
    if (dados.emPe && dados.emPe.length > 0) {
      linhas.push('"Passageiros em Pé:"');
      dados.emPe.forEach((p, i) => linhas.push(`"${i + 1}. ${p.nome}"`));
      linhas.push('');
    }

    if (dados.bancosTraseiros && dados.bancosTraseiros.length > 0) {
      linhas.push('"Bancos Traseiros do Dia:"');
      dados.bancosTraseiros.forEach((p, i) => linhas.push(`"${i + 1}. ${p.nome}"`));
    }
  }

  const csvContent = linhas.join('\n');
  const filename = `relatorio-onibus-${data}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csvContent); // BOM para Excel reconhecer UTF-8
});

/**
 * GET /api/relatorios/:data/pdf
 * Exporta o relatório de uma data como PDF (formato com 3 colunas) - com IDA e VOLTA separados
 */
app.get('/api/relatorios/:data/pdf', async (req, res) => {
  const { data } = req.params;
  const relatorio = (await db.execute({ sql: 'SELECT * FROM relatorios WHERE data = ?', args: [data] })).rows[0];
  if (!relatorio) {
    return res.status(404).json({ erro: 'Relatório não encontrado' });
  }

  const dados = JSON.parse(relatorio.dados_json);
  const filename = `relatorio-onibus-${data}.pdf`;

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.pipe(res);

  // Separa por tipo de resposta
  const vouEVolto = dados.passageiros.filter(p => p.resposta === 'vou_e_volto').map(p => p.nome);
  const soVou = dados.passageiros.filter(p => p.resposta === 'so_vou').map(p => p.nome);
  const soVolto = dados.passageiros.filter(p => p.resposta === 'so_volto').map(p => p.nome);

  // Título
  doc.fontSize(16).font('Helvetica-Bold').text('Relatório do Ônibus', { align: 'center' });
  doc.fontSize(11).font('Helvetica').text(`Data: ${data}`, { align: 'center' });
  doc.moveDown(0.5);

  // Resumo de contagem
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a365d')
    .text(`Total de pessoas no dia: ${relatorio.total_passageiros}`, { align: 'center' });
  doc.fontSize(10).font('Helvetica').fillColor('#000000')
    .text(`Vou e Volto: ${relatorio.total_vou_e_volto}  |  Só Vou: ${relatorio.total_so_vou}  |  Só Volto: ${relatorio.total_so_volto}`, { align: 'center' });
  doc.moveDown(1);

  // Configuração da tabela de 3 colunas
  const margemEsquerda = 40;
  const larguraPagina = 515;
  const larguraColuna = larguraPagina / 3;
  const alturaLinha = 18;
  const alturaCabecalho = 25;

  // Cabeçalhos das colunas (fundo azul escuro)
  const yInicio = doc.y;
  
  // Fundo do cabeçalho
  doc.rect(margemEsquerda, yInicio, larguraPagina, alturaCabecalho).fill('#1a365d');
  
  // Texto do cabeçalho
  doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
  doc.text('Vai e volta:', margemEsquerda + 5, yInicio + 7, { width: larguraColuna - 10, align: 'center' });
  doc.text('Só vai:', margemEsquerda + larguraColuna + 5, yInicio + 7, { width: larguraColuna - 10, align: 'center' });
  doc.text('Só volta:', margemEsquerda + larguraColuna * 2 + 5, yInicio + 7, { width: larguraColuna - 10, align: 'center' });

  // Linhas da tabela
  doc.fillColor('#000000').fontSize(9).font('Helvetica');
  const maxLinhas = Math.max(vouEVolto.length, soVou.length, soVolto.length);
  
  let yAtual = yInicio + alturaCabecalho;
  
  for (let i = 0; i < maxLinhas; i++) {
    // Alterna cor de fundo
    if (i % 2 === 0) {
      doc.rect(margemEsquerda, yAtual, larguraPagina, alturaLinha).fill('#f7fafc');
    } else {
      doc.rect(margemEsquerda, yAtual, larguraPagina, alturaLinha).fill('#ffffff');
    }
    
    doc.fillColor('#000000');
    
    // Bordas verticais
    doc.strokeColor('#e2e8f0').lineWidth(0.5);
    doc.moveTo(margemEsquerda + larguraColuna, yAtual).lineTo(margemEsquerda + larguraColuna, yAtual + alturaLinha).stroke();
    doc.moveTo(margemEsquerda + larguraColuna * 2, yAtual).lineTo(margemEsquerda + larguraColuna * 2, yAtual + alturaLinha).stroke();
    
    // Textos
    if (vouEVolto[i]) doc.text(vouEVolto[i], margemEsquerda + 5, yAtual + 4, { width: larguraColuna - 10 });
    if (soVou[i]) doc.text(soVou[i], margemEsquerda + larguraColuna + 5, yAtual + 4, { width: larguraColuna - 10 });
    if (soVolto[i]) doc.text(soVolto[i], margemEsquerda + larguraColuna * 2 + 5, yAtual + 4, { width: larguraColuna - 10 });
    
    yAtual += alturaLinha;
    
    // Nova página se necessário
    if (yAtual > 750) {
      doc.addPage();
      yAtual = 40;
    }
  }
  
  // Borda externa da tabela
  doc.strokeColor('#1a365d').lineWidth(1);
  doc.rect(margemEsquerda, yInicio, larguraPagina, alturaCabecalho + (maxLinhas * alturaLinha)).stroke();
  
  doc.y = yAtual + 20;

  // Verifica se é formato novo (com ida/volta) ou antigo
  if (dados.ida && dados.volta) {
    // ========== SEÇÃO IDA ==========
    doc.moveDown();
    if (doc.y > 700) { doc.addPage(); }
    
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#1a56db')
       .text(`IDA (${dados.ida.totalPresentes || dados.ida.sentados.length} pessoas)`);
    doc.moveDown(0.5);

    if (dados.ida.emPe && dados.ida.emPe.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#c53030')
         .text(`Em Pé na IDA (${dados.ida.emPe.length})`);
      doc.fontSize(10).font('Helvetica').fillColor('#000000');
      dados.ida.emPe.forEach((p, i) => doc.text(`${i + 1}. ${p.nome}`));
      doc.moveDown(0.5);
    }

    if (dados.ida.bancosTraseiros && dados.ida.bancosTraseiros.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#c27803')
         .text(`Bancos Traseiros na IDA (${dados.ida.bancosTraseiros.length})`);
      doc.fontSize(10).font('Helvetica').fillColor('#000000');
      dados.ida.bancosTraseiros.forEach((p, i) => doc.text(`${i + 1}. ${p.nome}`));
      doc.moveDown(0.5);
    }

    // ========== SEÇÃO VOLTA ==========
    doc.moveDown();
    if (doc.y > 700) { doc.addPage(); }
    
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#057a55')
       .text(`VOLTA (${dados.volta.totalPresentes || dados.volta.sentados.length} pessoas)`);
    doc.moveDown(0.5);

    if (dados.volta.emPe && dados.volta.emPe.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#c53030')
         .text(`Em Pé na VOLTA (${dados.volta.emPe.length})`);
      doc.fontSize(10).font('Helvetica').fillColor('#000000');
      dados.volta.emPe.forEach((p, i) => doc.text(`${i + 1}. ${p.nome}`));
      doc.moveDown(0.5);
    }

    if (dados.volta.bancosTraseiros && dados.volta.bancosTraseiros.length > 0) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#c27803')
         .text(`Bancos Traseiros na VOLTA (${dados.volta.bancosTraseiros.length})`);
      doc.fontSize(10).font('Helvetica').fillColor('#000000');
      dados.volta.bancosTraseiros.forEach((p, i) => doc.text(`${i + 1}. ${p.nome}`));
    }
  } else {
    // Formato antigo: compatibilidade
    if (dados.emPe && dados.emPe.length > 0) {
      doc.moveDown();
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#c53030').text('Passageiros em Pé');
      doc.fontSize(10).font('Helvetica').fillColor('#000000');
      dados.emPe.forEach((p, i) => doc.text(`${i + 1}. ${p.nome}`));
      doc.moveDown();
    }

    if (dados.bancosTraseiros && dados.bancosTraseiros.length > 0) {
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#c27803').text('Bancos Traseiros do Dia');
      doc.fontSize(10).font('Helvetica').fillColor('#000000');
      dados.bancosTraseiros.forEach((p, i) => doc.text(`${i + 1}. ${p.nome}`));
    }
  }

  doc.end();
});

// Rota para a página administrativa (com rate limit geral)
app.get('/admin', limiteGeral, async (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Inicia o servidor
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
  console.log(`📊 Painel admin em http://localhost:${PORT}/admin`);
});

module.exports = app;
