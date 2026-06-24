/* =====================================================================
   PSU-12 — Simulador de Fonte de Alimentação Linear Regulada
   Lógica da aplicação: estado da simulação, animações, painel lateral
   de componentes, osciloscópio e modo diagnóstico.
   Código comentado em português para fins didáticos.
   ===================================================================== */

(() => {
  'use strict';

  /* ------------------------------------------------------------------
   * 1. ESTADO GLOBAL
   * ------------------------------------------------------------------ */
  const state = {
    inputVoltage: 127,   // 127 ou 220 (V AC)
    currentStep: 0,      // 0 = nada iniciado, 1..5 = etapas concluídas
    running: false,
    timers: [],          // guarda os setTimeout para poder cancelar no reset
  };

  /* ------------------------------------------------------------------
   * 2. REFERÊNCIAS DO DOM
   * ------------------------------------------------------------------ */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const els = {
    themeToggle: $('#themeToggle'),
    body: document.body,

    voltageButtons: $$('.voltage-btn'),
    labelRede: $('#labelRede'),
    readTransIn: $('#readTransIn'),

    btnStart: $('#btnStart'),
    btnReset: $('#btnReset'),

    energyFill: $('#energyFill'),
    energyPct: $('#energyPct'),
    stageLabels: $$('.energy-meter__stages span'),

    statusStrip: $('#statusStrip'),
    statusText: $('#statusText'),
    ledStatus: $('#ledStatus'),

    energyPath: $('#energyPath'),
    energyDot: $('#energyDot'),
    nodes: $$('.node'),

    stepCards: $$('.step-card'),
    ledOutput: $('#ledOutput'),
    outputCheck: $('#outputCheck'),

    scopeBefore: $('#scopeBefore'),
    scopeAfter: $('#scopeAfter'),
    diagTrans: $('#diagTrans'),
    diagRect: $('#diagRect'),
    diagRipple: $('#diagRipple'),
    diagReg: $('#diagReg'),
    diagStatus: $('#diagStatus'),
    diagItems: $$('.diag-item'),

    overlay: $('#overlay'),
    sidePanel: $('#sidePanel'),
    sidePanelClose: $('#sidePanelClose'),
    sidePanelSymbol: $('#sidePanelSymbol'),
    sidePanelEyebrow: $('#sidePanelEyebrow'),
    sidePanelName: $('#sidePanelName'),
    sidePanelFunction: $('#sidePanelFunction'),
    sidePanelDetail: $('#sidePanelDetail'),
    sidePanelSpecs: $('#sidePanelSpecs'),
  };

  // Comprimento total aproximado da trilha SVG (para o efeito de "energia percorrendo o circuito")
  const TRACK_LENGTH = 1500;
  // Posições X de cada nó ao longo da trilha (usadas para mover o ponto de energia)
  const NODE_X = { rede:70, transformador:220, retificador:380, capacitor:540, regulador:700, saida:860, carga:1020 };

  /* ------------------------------------------------------------------
   * 3. TEMA CLARO / ESCURO
   * ------------------------------------------------------------------ */
  function initTheme(){
    const saved = localStorage.getItem('psu12-theme');
    if (saved) els.body.setAttribute('data-theme', saved);
  }
  els.themeToggle.addEventListener('click', () => {
    const next = els.body.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    els.body.setAttribute('data-theme', next);
    localStorage.setItem('psu12-theme', next);
  });
  initTheme();

  /* ------------------------------------------------------------------
   * 4. SELEÇÃO DA TENSÃO DE ENTRADA
   * ------------------------------------------------------------------ */
  els.voltageButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.running) return; // não permite trocar durante a simulação
      els.voltageButtons.forEach(b => { b.classList.remove('is-active'); b.setAttribute('aria-checked','false'); });
      btn.classList.add('is-active');
      btn.setAttribute('aria-checked','true');
      state.inputVoltage = Number(btn.dataset.voltage);
      els.labelRede.textContent = `${state.inputVoltage}V AC`;
      els.readTransIn.textContent = `${state.inputVoltage} V AC`;
    });
  });

  /* ------------------------------------------------------------------
   * 5. CONTROLE DE PROGRESSO / ENERGIA
   * ------------------------------------------------------------------ */
  const STEP_PCT = [0, 20, 40, 60, 80, 100]; // % de energia por etapa concluída

  function setEnergy(step){
    const pct = STEP_PCT[step] ?? 0;
    els.energyFill.style.width = pct + '%';
    els.energyPct.textContent = pct + '%';
    els.stageLabels.forEach(lbl => {
      const s = Number(lbl.dataset.stage);
      lbl.classList.toggle('is-done', s < step);
      lbl.classList.toggle('is-current', s === step);
    });
  }

  function setStatus(text, mode){
    els.statusText.textContent = text;
    els.ledStatus.className = 'led ' + (mode === 'on' ? 'led--on' : 'led--off');
  }

  /* ------------------------------------------------------------------
   * 6. ANIMAÇÃO DA TRILHA DE ENERGIA NO DIAGRAMA SVG
   * ------------------------------------------------------------------ */
  function animateTrackTo(nodeKey, color){
    const targetX = NODE_X[nodeKey];
    const totalSpan = NODE_X.carga - NODE_X.rede;
    const progressed = (targetX - NODE_X.rede) / totalSpan;
    const offset = TRACK_LENGTH - (TRACK_LENGTH * progressed);

    els.energyPath.style.stroke = color;
    els.energyPath.style.strokeDashoffset = String(offset);

    els.energyDot.classList.add('is-active');
    els.energyDot.setAttribute('fill', color);
    els.energyDot.style.filter = `drop-shadow(0 0 6px ${color})`;
    els.energyDot.setAttribute('cx', String(targetX));
  }

  function markNodeActive(nodeKey){
    els.nodes.forEach(n => n.classList.remove('is-active'));
    const node = els.nodes.find(n => n.dataset.node === nodeKey);
    if (node) node.classList.add('is-active');
  }
  function markNodeDone(nodeKey){
    const node = els.nodes.find(n => n.dataset.node === nodeKey);
    if (node) { node.classList.remove('is-active'); node.classList.add('is-done'); }
  }

  /* ------------------------------------------------------------------
   * 7. CARTÕES DE ETAPA (steps-grid)
   * ------------------------------------------------------------------ */
  function setStepState(stepNum, mode){
    const card = els.stepCards.find(c => Number(c.dataset.step) === stepNum);
    if (!card) return;
    card.classList.remove('is-active','is-done');
    if (mode) card.classList.add(mode);
  }

  /* ------------------------------------------------------------------
   * 8. OSCILOSCÓPIO — desenhos de formas de onda dinâmicas e mini-waves
   * ------------------------------------------------------------------ */
  function buildWavePath(points){
    return points.map((p,i) => (i===0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(' ');
  }

  function drawScopeBefore(){
    const pts = [];
    const w = 400, midY = 110, amp = 85;
    for (let x = 0; x <= w; x += 4){
      const phase = (x / 40) * Math.PI;
      const v = Math.abs(Math.sin(phase));
      pts.push([x, midY - v * amp]);
    }
    els.scopeBefore.innerHTML = `
      <path d="${buildWavePath(pts)}" fill="none" stroke="var(--pulse)" stroke-width="2.5" stroke-linejoin="round" class="wave-pulse"/>
      <line x1="0" y1="${midY+5}" x2="${w}" y2="${midY+5}" stroke="var(--line)" stroke-width="1"/>
    `;

    // Injeta grafismo dinâmico no card 2
    const $miniWaveRect = $('#waveRectifier');
    if($miniWaveRect) {
      $miniWaveRect.innerHTML = `<svg viewBox="0 0 100 30" style="width:100%; height:100%;"><path d="M0,25 Q12,5 25,25 T50,25 T75,25 T100,25" fill="none" stroke="var(--pulse)" stroke-width="2" stroke-linecap="round"/></svg>`;
    }
  }

  function drawScopeAfter(rippleFactor){
    const pts = [];
    const w = 400, baseY = 35, amp = 4 * rippleFactor;
    for (let x = 0; x <= w; x += 4){
      const phase = (x / 40) * Math.PI;
      const v = Math.sin(phase * 2);
      pts.push([x, baseY - v * amp]);
    }
    els.scopeAfter.innerHTML = `
      <path d="${buildWavePath(pts)}" fill="none" stroke="var(--dc)" stroke-width="2.5" stroke-linejoin="round" class="wave-move"/>
      <line x1="0" y1="${baseY+5}" x2="${w}" y2="${baseY+5}" stroke="var(--line)" stroke-width="1"/>
    `;

    // Injeta grafismo dinâmico no card 3
    const $miniWaveCap = $('#waveCapacitor');
    if($miniWaveCap) {
      $miniWaveCap.innerHTML = `<svg viewBox="0 0 100 30" style="width:100%; height:100%;"><path d="M0,15 Q25,12 50,15 T100,15" fill="none" stroke="var(--dc)" stroke-width="2" stroke-linecap="round"/></svg>`;
    }
  }

  function drawScopeFlat(svg, label){
    svg.innerHTML = `<text x="200" y="70" text-anchor="middle" fill="var(--text-faint)" font-family="JetBrains Mono, monospace" font-size="11">${label}</text>`;
  }

  /* ------------------------------------------------------------------
   * 9. DIAGNÓSTICO
   * ------------------------------------------------------------------ */
  function resetDiagnostics(){
    els.diagTrans.textContent = '—';
    els.diagRect.textContent = '—';
    els.diagRipple.textContent = '—';
    els.diagReg.textContent = '—';
    els.diagStatus.textContent = 'Em espera';
    els.diagItems.forEach(it => it.setAttribute('data-ok','true'));
  }

  function updateDiagnostics(field, value){
    if (field === 'trans') els.diagTrans.textContent = value;
    if (field === 'rect')  els.diagRect.textContent = value;
    if (field === 'ripple')els.diagRipple.textContent = value;
    if (field === 'reg')   els.diagReg.textContent = value;
    if (field === 'status')els.diagStatus.textContent = value;
  }

  /* ------------------------------------------------------------------
   * 10. SEQUÊNCIA PRINCIPAL DA SIMULAÇÃO
   * ------------------------------------------------------------------ */
  function scheduleStep(fn, delay){
    const id = setTimeout(fn, delay);
    state.timers.push(id);
  }

  function runSimulation(){
    if (state.running) return;
    state.running = true;
    els.btnStart.disabled = true;
    setStatus('Simulação em execução…', 'on');
    setEnergy(0);

    const Vin = state.inputVoltage;

    // --- Etapa 0: energiza a rede -------------------------------------
    markNodeActive('rede');
    animateTrackTo('rede', 'var(--ac)');

    // --- Etapa 1: Transformador ----------------------------------------
    scheduleStep(() => {
      markNodeActive('transformador');
      animateTrackTo('transformador', 'var(--ac)');
      setStepState(1, 'is-active');
      setEnergy(1);
      updateDiagnostics('trans', `${Vin}V → 15V AC`);
    }, 600);

    scheduleStep(() => {
      markNodeDone('transformador');
      setStepState(1, 'is-done');
    }, 1500);

    // --- Etapa 2: Ponte retificadora ------------------------------------
    scheduleStep(() => {
      markNodeActive('retificador');
      animateTrackTo('retificador', 'var(--pulse)');
      setStepState(2, 'is-active');
      setEnergy(2);
      drawScopeBefore();
      updateDiagnostics('rect', '≈20V DC pulsante');
    }, 1900);

    scheduleStep(() => {
      markNodeDone('retificador');
      setStepState(2, 'is-done');
    }, 2900);

    // --- Etapa 3: Filtro capacitivo --------------------------------------
    scheduleStep(() => {
      markNodeActive('capacitor');
      animateTrackTo('capacitor', 'var(--pulse)');
      setStepState(3, 'is-active');
      setEnergy(3);
      
      if(Vin === 220) {
        drawScopeAfter(1.6);
        updateDiagnostics('ripple', 'Reduzido (≈ 5%)');
      } else {
        drawScopeAfter(1.2);
        updateDiagnostics('ripple', 'Reduzido (≈ 3%)');
      }
    }, 3300);

    scheduleStep(() => {
      markNodeDone('capacitor');
      setStepState(3, 'is-done');
      drawScopeAfter(Vin === 220 ? 1.2 : 0.8); // estabiliza visualmente
    }, 4300);

    // --- Etapa 4: Regulador LM7812 ---------------------------------------
    scheduleStep(() => {
      markNodeActive('regulador');
      animateTrackTo('regulador', 'var(--dc)');
      setStepState(4, 'is-active');
      setEnergy(4);
      
      // Inteligência de Diagnóstico baseada no estresse de tensão (127V vs 220V)
      if(Vin === 220) {
        updateDiagnostics('reg', '12V DC (Aquecimento ↑)');
      } else {
        updateDiagnostics('reg', '12V DC estável');
      }
    }, 4700);

    scheduleStep(() => {
      markNodeDone('regulador');
      setStepState(4, 'is-done');
    }, 5700);

    // --- Etapa 5: Saída ----------------------------------------------------
    scheduleStep(() => {
      markNodeActive('saida');
      animateTrackTo('saida', 'var(--dc)');
      setStepState(5, 'is-active');
    }, 6100);

    scheduleStep(() => {
      markNodeDone('saida');
      markNodeActive('carga');
      animateTrackTo('carga', 'var(--dc)');
      setStepState(5, 'is-done');
      setEnergy(5);

      els.ledOutput.className = 'led led--on';
      els.outputCheck.textContent = '✔ Fonte operando corretamente — saída estável em 12V DC';
      updateDiagnostics('status', 'Operacional ✔');
      setStatus('Saída 12V DC estável — fonte operacional', 'on');
    }, 6900);

    scheduleStep(() => {
      markNodeDone('carga');
      state.running = false;
      els.btnStart.disabled = false;
    }, 7300);
  }

  els.btnStart.addEventListener('click', runSimulation);

  /* ------------------------------------------------------------------
   * 11. RESET
   * ------------------------------------------------------------------ */
  function resetSimulation(){
    state.timers.forEach(id => clearTimeout(id));
    state.timers = [];
    state.running = false;
    els.btnStart.disabled = false;

    setEnergy(0);
    setStatus('Sistema em espera', 'off');

    els.nodes.forEach(n => n.classList.remove('is-active','is-done'));
    els.energyPath.style.strokeDashoffset = String(TRACK_LENGTH);
    els.energyDot.classList.remove('is-active');

    els.stepCards.forEach(c => c.classList.remove('is-active','is-done'));

    els.ledOutput.className = 'led led--off';
    els.outputCheck.textContent = 'Aguardando simulação…';

    // Limpa os cards de mini-waves
    const $miniWaveRect = $('#waveRectifier');
    const $miniWaveCap = $('#waveCapacitor');
    if($miniWaveRect) $miniWaveRect.innerHTML = '';
    if($miniWaveCap) $miniWaveCap.innerHTML = '';

    drawScopeFlat(els.scopeBefore, 'Aguardando início da simulação');
    drawScopeFlat(els.scopeAfter, 'Aguardando início da simulação');
    resetDiagnostics();
  }
  els.btnReset.addEventListener('click', resetSimulation);

  /* ------------------------------------------------------------------
   * 12. PAINEL LATERAL — ficha técnica de cada componente
   * ------------------------------------------------------------------ */
  const COMPONENTS = {
    rede: {
      eyebrow: 'Entrada de energia',
      name: 'Rede elétrica (AC)',
      func: 'Fornece a energia elétrica alternada que alimenta todo o sistema.',
      detail: 'A rede de distribuição entrega corrente alternada (AC), cuja tensão inverte de polaridade periodicamente — 60 vezes por segundo no padrão brasileiro (60 Hz). É essa energia, bruta e variável, que a fonte de alimentação precisa converter em corrente contínua estável.',
      symbol: `<svg viewBox="0 0 100 100"><path d="M15 50 Q 30 20, 45 50 T 75 50" fill="none" stroke="currentColor" stroke-width="4"/><circle cx="15" cy="50" r="4" fill="currentColor"/><circle cx="85" cy="50" r="4" fill="currentColor"/></svg>`,
      specs: [['Tensão típica','127V / 220V AC'],['Frequência','60 Hz (Brasil)'],['Tipo de corrente','Alternada (AC)']]
    },
    transformador: {
      eyebrow: 'Bloco 1',
      name: 'Transformador 15V',
      func: 'Reduz a tensão da rede elétrica para um valor seguro e adequado ao circuito.',
      detail: 'Formado por duas bobinas enroladas em um núcleo de ferro laminado, o transformador transfere energia por acoplamento magnético — sem contato elétrico direto entre a entrada e a saída. A relação entre o número de voltas de cada bobina define a proporção de redução da tensão, mantendo a forma de onda alternada (AC).',
      symbol: `<svg viewBox="0 0 100 100"><path d="M30 25c8 0 8 12.5 0 12.5s-8 12.5 0 12.5 8 12.5 0 12.5" fill="none" stroke="currentColor" stroke-width="3"/><path d="M70 25c-8 0-8 12.5 0 12.5s8 12.5 0 12.5-8 12.5 0 12.5" fill="none" stroke="currentColor" stroke-width="3"/><line x1="50" y1="20" x2="50" y2="80" stroke="currentColor" stroke-width="5"/></svg>`,
      specs: [['Entrada','127V / 220V AC'],['Saída','15V AC'],['Isolação','Galvânica (sem contato direto)']]
    },
    retificador: {
      eyebrow: 'Bloco 2',
      name: 'Ponte retificadora (4× 1N4007)',
      func: 'Converte corrente alternada (AC) em corrente contínua pulsante (DC).',
      detail: 'Quatro diodos 1N4007 dispostos em formato de ponte conduzem a corrente sempre no mesmo sentido, independentemente da polaridade instantânea da entrada AC. O resultado é uma tensão contínua, porém ainda "pulsante", com picos e vales seguindo o ritmo da onda original.',
      symbol: `<svg viewBox="0 0 100 100"><path d="M30 30 L50 50 L30 70" fill="none" stroke="currentColor" stroke-width="3"/><path d="M70 30 L50 50 L70 70" fill="none" stroke="currentColor" stroke-width="3"/><path d="M30 70 L50 50 L30 30" fill="none" stroke="currentColor" stroke-width="3" transform="translate(0,0)"/><circle cx="50" cy="50" r="40" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="4 4"/></svg>`,
      specs: [['Entrada','15V AC'],['Saída','≈20V DC pulsante'],['Componente','4× diodo 1N4007']]
    },
    capacitor: {
      eyebrow: 'Bloco 3',
      name: 'Capacitor eletrolítico 2200 µF',
      func: 'Filtra a tensão contínua pulsante, reduzindo a ondulação (ripple).',
      detail: 'O capacitor se carrega nos picos da onda pulsante e libera essa carga gradualmente nos intervalos entre picos, "preenchendo os vales" da onda. O resultado é uma tensão contínua muito mais estável, embora ainda com uma pequena ondulação residual que será eliminada pelo regulador.',
      symbol: `<svg viewBox="0 0 100 100"><line x1="40" y1="20" x2="40" y2="80" stroke="currentColor" stroke-width="5"/><path d="M60 20 Q70 50 60 80" fill="none" stroke="currentColor" stroke-width="5"/><line x1="20" y1="50" x2="40" y2="50" stroke="currentColor" stroke-width="3"/><line x1="60" y1="50" x2="80" y2="50" stroke="currentColor" stroke-width="3"/></svg>`,
      specs: [['Capacitância','2200 µF'],['Função','Filtragem / redução de ripple'],['Tipo','Eletrolítico']]
    },
    regulador: {
      eyebrow: 'Bloco 4',
      name: 'Regulador de tensão LM7812',
      func: 'Mantém a tensão de saída fixa em 12V DC, mesmo com variações na entrada.',
      detail: 'O LM7812 é um regulador linear de três terminais (entrada, GND e saída) que dissipa o excesso de tensão na forma de calor, entregando sempre 12V estáveis na saída — desde que a entrada permaneça acima de um mínimo necessário (tipicamente ~14V). Os capacitores cerâmicos de 100nF nos terminais garantem estabilidade contra oscilações de alta frequência.',
      symbol: `<svg viewBox="0 0 100 100"><rect x="25" y="35" width="50" height="35" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><text x="50" y="58" text-anchor="middle" font-family="monospace" font-size="11" fill="currentColor">7812</text><line x1="35" y1="70" x2="35" y2="85" stroke="currentColor" stroke-width="3"/><line x1="50" y1="70" x2="50" y2="85" stroke="currentColor" stroke-width="3"/><line x1="65" y1="70" x2="65" y2="85" stroke="currentColor" stroke-width="3"/></svg>`,
      specs: [['Entrada','≈20V DC'],['Saída','12V DC regulados'],['Encapsulamento','TO-220']]
    },
    saida: {
      eyebrow: 'Bloco 5',
      name: 'Saída regulada + LED indicador',
      func: 'Entrega 12V DC estáveis ao circuito final e indica visualmente o funcionamento.',
      detail: 'O LED, em série com um resistor de 330 Ω (responsável por limitar a corrente e proteger o LED), acende quando a saída de 12V está presente e estável — funcionando como um indicador simples e confiável de que toda a cadeia de conversão funcionou corretamente.',
      symbol: `<svg viewBox="0 0 100 100"><path d="M30 30 a20 20 0 1 1 0 40 a20 20 0 1 1 0-40Z" fill="none" stroke="currentColor" stroke-width="3"/><line x1="30" y1="70" x2="20" y2="85" stroke="currentColor" stroke-width="3"/><line x1="30" y1="70" x2="40" y2="85" stroke="currentColor" stroke-width="3"/><path d="M55 35 l10-10 m-4 14 l10-10" stroke="currentColor" stroke-width="2.5"/></svg>`,
      specs: [['Tensão de saída','12V DC'],['Resistor limitador','330 Ω'],['Indicador','LED']]
    },
    carga: {
      eyebrow: 'Etapa final',
      name: 'Carga / circuito alimentado',
      func: 'Representa o circuito eletrônico final que consome a energia já tratada.',
      detail: 'É aqui que a energia, agora limpa e estável in 12V DC, é efetivamente utilizada — alimentando microcontroladores, sensores, módulos de comunicação ou qualquer outro circuito sensível a variações de tensão.',
      symbol: `<svg viewBox="0 0 100 100"><rect x="30" y="30" width="40" height="40" rx="4" fill="none" stroke="currentColor" stroke-width="3"/><line x1="40" y1="22" x2="40" y2="30" stroke="currentColor" stroke-width="2.5"/><line x1="60" y1="22" x2="60" y2="30" stroke="currentColor" stroke-width="2.5"/><line x1="40" y1="70" x2="40" y2="78" stroke="currentColor" stroke-width="2.5"/><line x1="60" y1="70" x2="60" y2="78" stroke="currentColor" stroke-width="2.5"/></svg>`,
      specs: [['Alimentação requerida','12V DC'],['Sensibilidade','Alta a variações de tensão']]
    },
  };

  function openSidePanel(key){
    const data = COMPONENTS[key];
    if (!data) return;
    els.sidePanelEyebrow.textContent = data.eyebrow;
    els.sidePanelName.textContent = data.name;
    els.sidePanelFunction.textContent = data.func;
    els.sidePanelDetail.textContent = data.detail;
    els.sidePanelSymbol.innerHTML = data.symbol;
    els.sidePanelSpecs.innerHTML = data.specs
      .map(([k,v]) => `<div class="spec-row"><span>${k}</span><span>${v}</span></div>`)
      .join('');

    els.overlay.classList.add('is-visible');
    els.sidePanel.classList.add('is-open');
    els.sidePanel.setAttribute('aria-hidden','false');
  }

  function closeSidePanel(){
    els.overlay.classList.remove('is-visible');
    els.sidePanel.classList.remove('is-open');
    els.sidePanel.setAttribute('aria-hidden','true');
  }

  els.nodes.forEach(node => {
    const key = node.dataset.node;
    node.addEventListener('click', () => openSidePanel(key));
    node.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openSidePanel(key); }
    });
  });
  els.sidePanelClose.addEventListener('click', closeSidePanel);
  els.overlay.addEventListener('click', closeSidePanel);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSidePanel(); });

  /* ------------------------------------------------------------------
   * 13. INICIALIZAÇÃO
   * ------------------------------------------------------------------ */
  function init(){
    setEnergy(0);
    els.energyPath.style.strokeDashoffset = String(TRACK_LENGTH);
    drawScopeFlat(els.scopeBefore, 'Aguardando início da simulação');
    drawScopeFlat(els.scopeAfter, 'Aguardando início da simulação');
    resetDiagnostics();
  }
  init();

})();