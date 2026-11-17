// ===== CONFIGURAÇÃO =====
const API_URL = "https://purple-resonance-193c.raspy-pond-9283.workers.dev";

// MODO DE TESTE: true inicia diretamente na tela de pedidos, sem login/API.
// Ao retomar o fluxo real, altere para false.
const MODO_TESTE = true;

const CLIENTE_TESTE = {
  name: 'Cliente de Teste',
  documento: '00000000000'
};

const PEDIDOS_TESTE = [
  { id: 'PV000123', descricao: 'Pedido de demonstração', tipo: 'Venda' },
  { id: 'PV000124', descricao: 'Segundo pedido de demonstração', tipo: 'Venda' }
];

// ===== ESTADO =====
const estado = {
  tela: MODO_TESTE ? 'pedidos' : 'cpf',
  cliente: MODO_TESTE ? CLIENTE_TESTE : null,
  pedidos: MODO_TESTE ? PEDIDOS_TESTE : [],
  filtro: '',
  importacao: {
    arquivo: null,
    itens: [],
    erros: [],
    processada: false,
    pedidoGerado: null
  }
};

// ===== UTILITÁRIOS =====
function escapeHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function normalizarCabecalho(valor) {
  return String(valor ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function formatarQuantidade(valor) {
  return new Intl.NumberFormat('pt-BR', {
    maximumFractionDigits: 4
  }).format(valor);
}

// Converte números no padrão brasileiro ou internacional.
// Exemplos: 10 | "10" | "1,5" | "1.234,56" | "1,234.56"
function converterQuantidade(valor) {
  if (typeof valor === 'number') {
    return Number.isFinite(valor) && valor > 0 ? valor : null;
  }

  let texto = String(valor ?? '').trim();
  if (!texto) return null;

  texto = texto.replace(/\s/g, '');

  const temVirgula = texto.includes(',');
  const temPonto = texto.includes('.');

  if (temVirgula && temPonto) {
    if (texto.lastIndexOf(',') > texto.lastIndexOf('.')) {
      texto = texto.replace(/\./g, '').replace(',', '.');
    } else {
      texto = texto.replace(/,/g, '');
    }
  } else if (temVirgula) {
    texto = texto.replace(',', '.');
  }

  const numero = Number(texto);
  return Number.isFinite(numero) && numero > 0 ? numero : null;
}

// ===== PONTO DE ENTRADA =====
function render() {
  const app = document.getElementById('app');
  const subtitulo = document.getElementById('subtitulo');

  if (estado.tela === 'cpf') {
    subtitulo.textContent = 'Informe seu CPF ou CNPJ para começar';
    app.innerHTML = telaCPF();
    bindTelaCPF();
  } else if (estado.tela === 'pedidos') {
    subtitulo.textContent = `Pedidos de ${estado.cliente?.name ?? ''}`;
    app.innerHTML = telaPedidos();
    bindTelaPedidos();
  } else if (estado.tela === 'importacao') {
    subtitulo.textContent = 'Importação de pedido';
    app.innerHTML = telaImportacao();
    bindTelaImportacao();
  }
}

// ===== TELA 1: CPF / CNPJ =====
function telaCPF() {
  return `
    <div class="card card-consulta mb-3">
      <div class="card-body p-4">
        <form id="formCPF" novalidate>
          <div class="mb-4">
            <label class="form-label fw-semibold" for="documento">CPF ou CNPJ</label>
            <input type="text" class="form-control form-control-lg"
                   id="documento"
                   placeholder="Ex: 000.000.000-00 ou 00.000.000/0000-00"
                   inputmode="numeric" autocomplete="off" required>
            <div class="form-text">
              Informe apenas números, com ou sem pontuação.
            </div>
          </div>
          <button type="submit" class="btn btn-primary btn-lg w-100 fw-semibold">
            Consultar
          </button>
        </form>
      </div>
    </div>
  `;
}

function bindTelaCPF() {
  document.getElementById('formCPF').addEventListener('submit', async (e) => {
    e.preventDefault();
    const documento = document.getElementById('documento').value.trim();
    await validarCliente(documento);
  });
}

// ===== VALIDAÇÃO DE DOCUMENTO =====
function validarDocumento(doc) {
  const limpo = doc.replace(/[.\-\/\s]/g, '');
  if (!/^\d+$/.test(limpo)) return null;
  if (limpo.length === 11) return 'CPF';
  if (limpo.length === 14) return 'CNPJ';
  return null;
}

function limparDocumento(doc) {
  return doc.replace(/[.\-\/\s]/g, '');
}

// ===== VALIDA CLIENTE =====
async function validarCliente(documento) {
  const app = document.getElementById('app');

  const tipo = validarDocumento(documento);
  if (!tipo) {
    app.innerHTML = `
      <div class="alert alert-warning">
        Documento inválido. Informe um CPF (11 dígitos) ou CNPJ (14 dígitos).
      </div>
      <button class="btn btn-outline-secondary w-100" id="btnTentarNovamente">
        Tentar novamente
      </button>`;
    document.getElementById('btnTentarNovamente').addEventListener('click', voltarCPF);
    return;
  }

  const docLimpo = limparDocumento(documento);
  app.innerHTML = `<div class="text-muted text-center py-4"><span class="spinner-border spinner-border-sm me-2"></span>Consultando...</div>`;

  try {
    const resp = await fetch(`${API_URL}/valida-cliente`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documento: docLimpo })
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    if (!data.cliente) {
      app.innerHTML = `
        <div class="alert alert-warning">
          Cliente não encontrado para o documento informado.
        </div>
        <button class="btn btn-outline-secondary w-100" id="btnTentarNovamente">
          Tentar novamente
        </button>`;
      document.getElementById('btnTentarNovamente').addEventListener('click', voltarCPF);
      return;
    }

    estado.cliente = data.cliente;
    estado.tela = 'pedidos';
    await carregarPedidos();

  } catch (err) {
    app.innerHTML = `
      <div class="alert alert-danger">Não foi possível consultar o cliente: ${escapeHtml(err.message)}</div>
      <button class="btn btn-outline-secondary w-100" id="btnTentarNovamente">
        Tentar novamente
      </button>`;
    document.getElementById('btnTentarNovamente').addEventListener('click', voltarCPF);
  }
}

// ===== TELA 2: PEDIDOS =====
async function carregarPedidos() {
  const app = document.getElementById('app');
  app.innerHTML = `<div class="text-muted text-center py-4"><span class="spinner-border spinner-border-sm me-2"></span>Carregando pedidos...</div>`;

  try {
    const resp = await fetch(`${API_URL}/lista-pedidos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documento: estado.cliente.documento })
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    estado.pedidos = data.items ?? [];
    estado.filtro = '';
    estado.tela = 'pedidos';
    render();

  } catch (err) {
    app.innerHTML = `
      <div class="alert alert-danger">Erro ao carregar pedidos: ${escapeHtml(err.message)}</div>
      <button class="btn btn-outline-secondary w-100" id="btnVoltarCPF">
        Voltar
      </button>`;
    document.getElementById('btnVoltarCPF').addEventListener('click', voltarCPF);
  }
}

function telaPedidos() {
  const filtrados = filtrarPedidos(estado.pedidos, estado.filtro);

  return `
    <div class="card card-consulta mb-3">
      <div class="card-body p-4">
        <div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
          <div>
            <div class="fw-semibold">${escapeHtml(estado.cliente?.name ?? '')}</div>
            <small class="text-muted">${escapeHtml(estado.cliente?.documento ?? '')}</small>
          </div>
          <div class="d-flex gap-2 flex-wrap">
            <button class="btn btn-sm btn-success" id="btnImportarPedido">
              <i class="bi bi-file-earmark-spreadsheet me-1"></i> Importar pedido
            </button>
            <button class="btn btn-sm btn-outline-secondary" id="btnNovaConsulta">
              Nova consulta
            </button>
          </div>
        </div>

        <div class="mb-3">
          <input type="text" class="form-control" id="busca"
                 placeholder="Buscar pedido..." value="${escapeHtml(estado.filtro)}">
        </div>

        <div class="text-muted small mb-2">
          ${filtrados.length} de ${estado.pedidos.length} pedido(s)
        </div>

        ${estado.pedidos.length === 0
          ? `<div class="text-muted text-center py-4">Não há pedidos.</div>`
          : filtrados.length === 0
            ? `<div class="text-muted text-center py-4">Nenhum pedido encontrado para essa pesquisa.</div>`
            : `<div class="list-group list-group-flush">
                ${filtrados.map(p => `
                  <div class="list-group-item pedido-item px-0">
                    <div class="d-flex justify-content-between align-items-start gap-3">
                      <div class="flex-grow-1">
                        <div class="fw-semibold">${escapeHtml(p.id ?? '-')}</div>
                        <small class="text-muted d-block">${escapeHtml(p.descricao ?? '')}</small>
                      </div>
                      <span class="badge bg-primary-subtle text-primary-emphasis">
                        ${escapeHtml(p.tipo ?? '-')}
                      </span>
                    </div>
                  </div>
                `).join('')}
              </div>`
        }
      </div>
    </div>
  `;
}

function bindTelaPedidos() {
  const busca = document.getElementById('busca');

  document.getElementById('btnImportarPedido')?.addEventListener('click', abrirImportacao);
  document.getElementById('btnNovaConsulta')?.addEventListener('click', voltarCPF);

  if (busca) {
    busca.addEventListener('input', (e) => {
      const posicao = e.target.selectionStart;
      estado.filtro = e.target.value;
      const app = document.getElementById('app');
      app.innerHTML = telaPedidos();
      bindTelaPedidos();
      const novoBusca = document.getElementById('busca');
      novoBusca.focus();
      novoBusca.setSelectionRange(posicao, posicao);
    });
  }
}

function filtrarPedidos(pedidos, filtro) {
  if (!filtro) return pedidos;
  const f = String(filtro).toLowerCase();
  return pedidos.filter(p =>
    String(p.id ?? '').toLowerCase().includes(f) ||
    String(p.descricao ?? '').toLowerCase().includes(f) ||
    String(p.tipo ?? '').toLowerCase().includes(f)
  );
}

// ===== TELA 3: IMPORTAÇÃO DE PEDIDO =====
function telaImportacao() {
  const imp = estado.importacao;

  return `
    <div class="card card-consulta mb-3">
      <div class="card-body p-4">
        <div class="d-flex justify-content-between align-items-center flex-wrap gap-2 mb-3">
          <div>
            <h5 class="mb-1 fw-bold">Importar pedido</h5>
            <div class="text-muted small">Selecione uma planilha com SKU e Quantidade.</div>
          </div>
          <button class="btn btn-sm btn-outline-secondary" id="btnVoltarPedidos">
            Voltar aos pedidos
          </button>
        </div>

        <div class="alert alert-light border small">
          <div class="fw-semibold mb-1">Formato esperado</div>
          <div>SKU | Quantidade</div>
          <div class="text-muted">Exemplo: PROD001 | 10</div>
          <div class="text-muted mt-1">Se um SKU aparecer mais de uma vez, as quantidades serão somadas.</div>
        </div>

        <div class="mb-3">
          <label for="arquivoPlanilha" class="form-label fw-semibold">Arquivo da planilha</label>
          <input class="form-control" type="file" id="arquivoPlanilha"
                 accept=".xlsx,.xls,.csv">
          <div class="form-text">Formatos aceitos: XLSX, XLS e CSV. Tamanho máximo: 5 MB.</div>
        </div>

        ${imp.arquivo ? `
          <div class="alert alert-secondary py-2 small mb-3">
            Arquivo selecionado: <strong>${escapeHtml(imp.arquivo)}</strong>
          </div>
        ` : ''}

        ${imp.processada ? renderResultadoImportacao() : `
          <div class="border rounded-3 text-center text-muted py-4">
            <i class="bi bi-file-earmark-spreadsheet fs-1 d-block mb-2"></i>
            A pré-visualização dos produtos aparecerá aqui.
          </div>
        `}
      </div>
    </div>
  `;
}

function renderResultadoImportacao() {
  const imp = estado.importacao;

  const resumo = `
    <div class="row g-2 mb-3">
      <div class="col-6">
        <div class="border rounded-3 p-3 h-100">
          <div class="text-muted small">SKUs após consolidação</div>
          <div class="fs-4 fw-bold">${imp.itens.length}</div>
        </div>
      </div>
      <div class="col-6">
        <div class="border rounded-3 p-3 h-100">
          <div class="text-muted small">Inconsistências</div>
          <div class="fs-4 fw-bold ${imp.erros.length ? 'text-danger' : 'text-success'}">${imp.erros.length}</div>
        </div>
      </div>
    </div>
  `;

  const tabela = imp.itens.length
    ? `
      <div class="table-responsive mb-3">
        <table class="table table-sm table-striped table-hover align-middle">
          <thead class="table-light">
            <tr>
              <th>SKU</th>
              <th class="text-end">Quantidade total</th>
            </tr>
          </thead>
          <tbody>
            ${imp.itens.map(item => `
              <tr>
                <td class="fw-semibold">${escapeHtml(item.sku)}</td>
                <td class="text-end">${formatarQuantidade(item.quantidade)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `
    : `<div class="alert alert-warning">Nenhum produto válido foi encontrado na planilha.</div>`;

  const erros = imp.erros.length
    ? `
      <div class="alert alert-danger">
        <div class="fw-semibold mb-2">Verifique as inconsistências:</div>
        <ul class="mb-0 ps-3">
          ${imp.erros.map(erro => `<li>${escapeHtml(erro)}</li>`).join('')}
        </ul>
      </div>
    `
    : `<div class="alert alert-success">Planilha lida sem inconsistências.</div>`;

  const pedidoGerado = imp.pedidoGerado
    ? `
      <div class="alert alert-success mt-3 mb-3">
        <div class="fw-semibold"><i class="bi bi-check-circle me-1"></i> Pedido de teste gerado!</div>
        <div>Número: <strong>${escapeHtml(imp.pedidoGerado.id)}</strong></div>
        <div class="small">O pedido foi incluído na lista desta sessão. Nenhum dado foi gravado no Protheus.</div>
      </div>
    `
    : '';

  const podeGerar = imp.itens.length > 0 && imp.erros.length === 0 && !imp.pedidoGerado;

  return `
    ${resumo}
    ${tabela}
    ${erros}
    ${pedidoGerado}
    <div class="d-flex justify-content-between align-items-center flex-wrap gap-2">
      <button class="btn btn-outline-primary" id="btnNovaPlanilha">
        <i class="bi bi-arrow-repeat me-1"></i> Selecionar outra planilha
      </button>
      <button class="btn btn-success" id="btnGerarPedido" ${podeGerar ? '' : 'disabled'}>
        <i class="bi bi-check2-circle me-1"></i> ${imp.pedidoGerado ? 'Pedido gerado' : 'Gerar pedido (teste)'}
      </button>
    </div>
    <div class="form-text mt-3">
      A geração é simulada nesta versão. Nenhum pedido é enviado ou gravado no Protheus.
    </div>
  `;
}

function bindTelaImportacao() {
  document.getElementById('btnVoltarPedidos')?.addEventListener('click', voltarPedidos);
  document.getElementById('arquivoPlanilha')?.addEventListener('change', (e) => {
    const arquivo = e.target.files?.[0];
    if (arquivo) processarPlanilha(arquivo);
  });
  document.getElementById('btnNovaPlanilha')?.addEventListener('click', limparImportacao);
  document.getElementById('btnGerarPedido')?.addEventListener('click', gerarPedidoTeste);
}

function abrirImportacao() {
  estado.importacao = {
    arquivo: null,
    itens: [],
    erros: [],
    processada: false,
    pedidoGerado: null
  };
  estado.tela = 'importacao';
  render();
}

function voltarPedidos() {
  estado.tela = 'pedidos';
  render();
}

function limparImportacao() {
  estado.importacao = {
    arquivo: null,
    itens: [],
    erros: [],
    processada: false,
    pedidoGerado: null
  };
  render();
}

async function processarPlanilha(arquivo) {
  const maxBytes = 5 * 1024 * 1024;
  if (arquivo.size > maxBytes) {
    estado.importacao = {
      arquivo: arquivo.name,
      itens: [],
      erros: ['O arquivo ultrapassa o limite de 5 MB.'],
      processada: true,
      pedidoGerado: null
    };
    render();
    return;
  }

  const extensao = arquivo.name.split('.').pop().toLowerCase();
  if (!['xlsx', 'xls', 'csv'].includes(extensao)) {
    estado.importacao = {
      arquivo: arquivo.name,
      itens: [],
      erros: ['Formato de arquivo não suportado. Selecione XLSX, XLS ou CSV.'],
      processada: true,
      pedidoGerado: null
    };
    render();
    return;
  }

  if (typeof XLSX === 'undefined') {
    estado.importacao.erros = ['Não foi possível carregar a biblioteca de leitura de planilhas. Atualize a página e tente novamente.'];
    estado.importacao.arquivo = arquivo.name;
    estado.importacao.processada = true;
    estado.importacao.pedidoGerado = null;
    render();
    return;
  }

  estado.importacao = {
    arquivo: arquivo.name,
    itens: [],
    erros: [],
    processada: false,
    pedidoGerado: null
  };
  render();

  try {
    const buffer = await arquivo.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });

    if (!workbook.SheetNames.length) {
      throw new Error('A planilha não possui nenhuma aba.');
    }

    const planilha = workbook.Sheets[workbook.SheetNames[0]];
    const linhas = XLSX.utils.sheet_to_json(planilha, {
      header: 1,
      defval: '',
      raw: false,
      blankrows: false
    });

    const resultado = interpretarLinhasPlanilha(linhas);

    estado.importacao = {
      arquivo: arquivo.name,
      itens: resultado.itens,
      erros: resultado.erros,
      processada: true,
      pedidoGerado: null
    };
    render();

  } catch (err) {
    estado.importacao = {
      arquivo: arquivo.name,
      itens: [],
      erros: [`Não foi possível ler a planilha: ${err.message}`],
      processada: true,
      pedidoGerado: null
    };
    render();
  }
}

function interpretarLinhasPlanilha(linhas) {
  const erros = [];
  const itensMap = new Map();

  if (!linhas.length) {
    return { itens: [], erros: ['A planilha está vazia.'] };
  }

  const cabecalho = linhas[0].map(normalizarCabecalho);
  const colunasPreenchidas = cabecalho
    .map((nome, indice) => ({ nome, indice }))
    .filter(coluna => coluna.nome !== '');

  if (colunasPreenchidas.length !== 2) {
    return {
      itens: [],
      erros: ['A planilha deve possuir exatamente duas colunas preenchidas: SKU e Quantidade.']
    };
  }

  const indiceSku = cabecalho.indexOf('sku');
  const indiceQuantidade = cabecalho.indexOf('quantidade');

  if (indiceSku === -1 || indiceQuantidade === -1 || indiceSku === indiceQuantidade) {
    return {
      itens: [],
      erros: ['Cabeçalho inválido. Utilize exatamente as colunas "SKU" e "Quantidade".']
    };
  }

  for (let i = 1; i < linhas.length; i++) {
    const linha = linhas[i];
    const skuOriginal = linha[indiceSku];
    const quantidadeOriginal = linha[indiceQuantidade];

    if (String(skuOriginal ?? '').trim() === '' &&
        String(quantidadeOriginal ?? '').trim() === '') {
      continue;
    }

    const sku = String(skuOriginal ?? '').trim();
    const quantidade = converterQuantidade(quantidadeOriginal);
    const numeroLinha = i + 1;

    if (!sku) {
      erros.push(`Linha ${numeroLinha}: SKU não informado.`);
      continue;
    }

    if (quantidade === null) {
      erros.push(`Linha ${numeroLinha}: quantidade inválida para o SKU "${sku}". Informe um número maior que zero.`);
      continue;
    }

    const skuChave = sku.toUpperCase();
    if (itensMap.has(skuChave)) {
      itensMap.get(skuChave).quantidade += quantidade;
    } else {
      itensMap.set(skuChave, {
        sku,
        quantidade
      });
    }
  }

  return {
    itens: Array.from(itensMap.values()),
    erros
  };
}

// ===== GERAÇÃO SIMULADA DO PEDIDO =====
function gerarPedidoTeste() {
  const imp = estado.importacao;

  // Evita gerar mais de um pedido para a mesma importação.
  if (imp.pedidoGerado || !imp.processada || !imp.itens.length || imp.erros.length) {
    return;
  }

  const sequencia = estado.pedidos.length + 1;
  const numero = `TESTE-${String(sequencia).padStart(4, '0')}`;

  estado.pedidos.unshift({
    id: numero,
    descricao: `Pedido de teste (${imp.itens.length} SKU(s))`,
    tipo: 'Venda - Teste'
  });

  imp.pedidoGerado = { id: numero, itens: imp.itens.length };
  render();
}

// ===== NAVEGAÇÃO =====
function voltarCPF() {
  estado.tela = 'cpf';
  estado.cliente = null;
  estado.pedidos = [];
  estado.filtro = '';
  estado.importacao = {
    arquivo: null,
    itens: [],
    erros: [],
    processada: false
  };
  render();
}

// ===== INICIALIZA =====
render();
