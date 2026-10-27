'use strict';

const codec = globalThis.HPPrimeCodec;
const images = globalThis.HPPrimeImages;
const { Connection, validateDevice, PROTOCOL2_MAX_BYTES } = globalThis.HPPrimeWebHID;
const element = id => document.getElementById(id);
const supported = Boolean(navigator.hid && globalThis.isSecureContext);
const documents = [];
let pages = [];
let prepared = [];
let connection;
let identified = false;
let busy = false;
let preparing = false;
let cancelled = false;
let reconnect = true;
let template;
let nextId = 0;
let pageDrag;
let suppressPreviewClick = false;
let organizerDocumentId;
let organizerAllPages = false;
let thumbnailObserver;
let thumbnailGeneration = 0;
let thumbnailScope;
let thumbnailWork = Promise.resolve();
const pendingThumbnails = new Map();
const formatBytes = bytes => bytes < 1024 ? `${bytes} B`
  : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KiB` : `${(bytes / 1048576).toFixed(2)} MiB`;
const mode = () => element('mode-combined').checked ? 'combined' : 'separate';
const settingsKey = source => `${source?.colors ?? 'color'}:${source?.resolution ?? 960}${source?.maximumColors !== undefined ? `:${source.maximumColors}` : ''}`;
const currentDocument = () => documents.find(source => source.id === organizerDocumentId);

function log(message) {
  element('log').textContent = (element('log').textContent +
    `${new Date().toLocaleTimeString()} ${message}\n`).slice(-20000);
  element('log').scrollTop = element('log').scrollHeight;
}

function update() {
  const connected = Boolean(connection && !connection.error && identified);
  const hasSelection = pages.length > 0 || documents.some(source => source.rangeDraft?.trim());
  element('connection-card').dataset.state = connected ? 'connected' : connection?.error ? 'error' : connection ? 'connecting' : 'idle';
  element('connection-indicator').textContent = connected ? 'OK' : connection?.error ? '!' : connection ? '…' : 'USB';
  element('delivery').setAttribute('aria-busy', String(busy));
  element('page-tray').setAttribute('aria-busy', String(busy));
  element('dropzone').setAttribute('aria-busy', String(busy));
  element('delivery').dataset.state = element('operation').className === 'error' ? 'error' : busy ? 'working' : prepared.length ? 'ready' : 'idle';
  element('send').textContent = busy ? 'Aguarde…' : 'Enviar para a HP Prime';
  element('download').textContent = busy ? 'Aguarde…' : 'Baixar .hpappdir';
  element('connect').hidden = connected;
  element('connect').disabled = busy || !supported || Boolean(connection);
  element('disconnect').hidden = !connection;
  element('disconnect').disabled = busy || !connection;
  for (const id of ['files', 'choose', 'clear', 'name', 'colors', 'resolution', 'mode-separate', 'mode-combined',
    'custom-resolution', 'palette', 'custom-colors', 'document-range', 'select-range', 'remove-document', 'organizer-scope']) {
    element(id).disabled = busy;
  }
  for (const control of element('documents').querySelectorAll('button, input, select')) control.disabled = busy;
  for (const control of element('previews').querySelectorAll('button')) {
    control.disabled = busy || control.dataset.unavailable === 'true';
  }
  element('prepare').disabled = busy || !hasSelection;
  element('prepare').textContent = preparing ? 'Aplicando…' : 'Aplicar';
  element('download').disabled = busy || !hasSelection;
  element('send').disabled = busy || !connected || (!hasSelection && !prepared.length) ||
    (prepared.length > 0 && (prepared.every(app => app.status === 'sent') ||
      prepared.some(app => app.bytes > connection.maxSendBytes || app.status === 'error')));
  element('cancel').hidden = !preparing;
  element('progress').hidden = !preparing && !prepared.some(app => ['sending', 'processing'].includes(app.status));
  element('cancel').disabled = cancelled;
  element('editor').hidden = documents.length === 0;
  element('dropzone').classList.toggle('compact', documents.length > 0);
  element('drop-title').textContent = documents.length ? `${documents.length} documento(s) adicionado(s)` : 'Arraste PDFs ou imagens';
  element('drop-description').textContent = documents.length ? 'Solte mais arquivos aqui ou adicione pelo botão.' : 'PDF, PNG, JPG, WebP, BMP e GIF · até 64 MiB de entrada';
  element('choose').textContent = documents.length ? 'Adicionar documentos' : 'Escolher arquivos';
  element('combined-name').hidden = mode() !== 'combined';
  element('page-count').textContent = `${organizerPages().length} página(s)`;
  element('selection-summary').textContent = `${documents.length} arquivo(s) · ${pages.length} página(s) selecionada(s)`;
  if (connection?.error) {
    element('connection').textContent = 'Conexão interrompida. Reconecte o cabo e a sessão.';
    element('connection').className = 'error';
  }
}

function invalidate(message = 'Os arquivos serão preparados ao enviar ou baixar.') {
  prepared = [];
  element('apps').replaceChildren();
  element('result-summary').hidden = true;
  element('result-summary').textContent = '';
  element('package').textContent = message;
  element('package').className = '';
  element('progress').value = 0;
  element('settings-status').className = 'muted';
  element('settings-status').textContent = 'Clique em Aplicar para preparar os apps com os ajustes escolhidos.';
  update();
}

async function run(action) {
  if (busy) return;
  busy = true;
  element('operation').className = '';
  update();
  try {
    await action();
  } catch (error) {
    element('operation').textContent = error.message;
    element('operation').className = 'error';
    if (!element('page-tray').hidden) {
      element('settings-status').textContent = error.message;
      element('settings-status').className = 'error';
    }
    log(`${error.name}: ${error.message}`);
  } finally {
    busy = false;
    update();
  }
}

async function connect(device) {
  validateDevice(device);
  element('connection').textContent = 'Identificando a HP Prime...';
  element('connection').className = '';
  await device.open();
  const current = new Connection(device, {
    onControl: report => log(`Controle USB: ${report.map(byte => byte.toString(16).padStart(2, '0')).join(' ')}`),
  });
  connection = current;
  identified = false;
  update();
  try {
    const info = await current.info();
    await current.enableProtocol2(true);
    if (connection !== current) throw new Error('Calculadora desconectada durante a identificação.');
    identified = true;
    element('connection').textContent = `HP Prime ${info.name} conectada.`;
    element('connection').className = 'connected';
    element('firmware').textContent = `Firmware ${info.firmware} · USBPROT2 com confirmação de blocos · HID ${current.reportBytes} bytes`;
    log(`HP Prime ${info.name} conectada · ${info.firmware} · USBPROT2 · HID ${current.reportBytes} bytes.`);
  } catch (error) {
    current.fail(error);
    throw error;
  }
}

element('connect').addEventListener('click', () => run(async () => {
  const devices = await navigator.hid.requestDevice({ filters: [0x0441, 0x1541, 0x2441].map(productId =>
    ({ vendorId: 0x03f0, productId })) });
  if (!devices.length) throw new Error('Nenhuma calculadora selecionada.');
  reconnect = true;
  await connect(devices[0]);
}));
element('disconnect').addEventListener('click', () => run(async () => {
  reconnect = false;
  const current = connection;
  await current.close();
  if (connection === current) connection = undefined;
  identified = false;
  element('connection').textContent = 'Nenhuma calculadora conectada.';
  element('connection').className = '';
  element('firmware').textContent = 'Sessão encerrada. Reconecte o cabo antes de abrir outra sessão USB.';
}));
element('support').hidden = supported;
element('support').textContent = supported ? ''
  : 'Download disponível neste navegador. Para enviar por USB, use Chrome ou Edge em localhost ou HTTPS.';

if (supported) {
  navigator.hid.addEventListener('disconnect', event => {
    if (connection?.device !== event.device) return;
    connection.device.removeEventListener('inputreport', connection.input);
    connection.fail(new Error('Cabo desconectado. O envio foi interrompido.'));
    connection = undefined;
    identified = false;
    for (const app of prepared) {
      if (['sending', 'processing'].includes(app.status)) app.status = 'error';
    }
    element('connection').textContent = 'HP Prime desconectada.';
    element('connection').className = '';
    log('A HP Prime foi desconectada.');
    renderApps();
  });
  navigator.hid.addEventListener('connect', event => {
    if (!connection && reconnect && !busy && event.device.vendorId === 0x03f0) run(() => connect(event.device));
  });
}

async function loadTemplate() {
  if (!template) {
    const fetchBytes = async url => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Falha ao carregar modelo: HTTP ${response.status} em ${url}.`);
      return new Uint8Array(await response.arrayBuffer());
    };
    const [descriptor, program, icon] = await Promise.all([
      fetchBytes('./template/descriptor'), fetchBytes('./template/program'), fetchBytes('./template/icon'),
    ]);
    template = { descriptor, program, source: codec.sourceRecord(program).text, icon };
  }
  return template;
}

async function openPDF(file) {
  const pdfjs = await import('./vendor/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.mjs', document.baseURI).href;
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false,
    useWasm: false, cMapUrl: new URL('./vendor/cmaps/', document.baseURI).href, cMapPacked: true,
    standardFontDataUrl: new URL('./vendor/standard_fonts/', document.baseURI).href,
  });
  let rejectPassword;
  const passwordFailure = new Promise((resolve, reject) => { rejectPassword = reject; });
  task.onPassword = () => rejectPassword(new Error(`PDF protegido por senha: ${file.name}. Use uma cópia sem senha.`));
  try {
    const pdf = await Promise.race([task.promise, passwordFailure]);
    return { pdf, destroy: () => task.destroy() };
  } catch (error) {
    await task.destroy();
    throw error;
  }
}

function discard(page, all = false) {
  if (page.url) URL.revokeObjectURL(page.url);
  if (all && page.thumbnail) URL.revokeObjectURL(page.thumbnail);
}

async function renderCover(file, pdf, number = 1) {
  let bitmap;
  let page;
  const canvas = document.createElement('canvas');
  try {
    page = pdf ? await pdf.getPage(number) : undefined;
    bitmap = pdf ? undefined : await createImageBitmap(file);
    const original = page ? page.getViewport({ scale: 1 }) : bitmap;
    const scale = Math.min(1, 180 / Math.max(original.width, original.height));
    canvas.width = Math.max(1, Math.round(original.width * scale));
    canvas.height = Math.max(1, Math.round(original.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error(`Não foi possível gerar a capa de ${file.name}.`);
    if (page) {
      await page.render({ canvasContext: context, viewport: page.getViewport({ scale }),
        background: 'rgb(255,255,255)', intent: 'print' }).promise;
    } else {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    }
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error(`Falha ao gerar a capa de ${file.name}.`);
    return URL.createObjectURL(blob);
  } finally {
    bitmap?.close();
    page?.cleanup();
    canvas.width = canvas.height = 1;
  }
}

function selectPages(documentId, range) {
  const source = documents.find(item => item.id === documentId);
  const selected = images.pageRange(range, source.count);
  const old = pages.filter(page => page.documentId === documentId);
  const first = pages.findIndex(page => page.documentId === documentId);
  const remaining = pages.filter(page => page.documentId !== documentId);
  const replacements = selected.map(number => old.find(page => page.number === number) ??
    { id: `${documentId}:${number}`, documentId, number });
  for (const page of old) if (!selected.includes(page.number)) discard(page, true);
  remaining.splice(first < 0 ? remaining.length : first, 0, ...replacements);
  pages = remaining;
  delete source.rangeDraft;
  invalidate();
  renderDocuments();
  renderPages();
}

async function addFiles(files) {
  const incoming = Array.from(files);
  if (!incoming.length) return;
  if ([...documents.map(item => item.file), ...incoming].reduce((sum, file) => sum + file.size, 0) > 64 * 1048576) {
    throw new Error('A seleção excede 64 MiB de arquivos de entrada. Remova arquivos antes de adicionar.');
  }
  const staged = [];
  const used = new Set(documents.map(item => item.name.toLowerCase()));
  try {
    for (const file of incoming) {
      if (!/\.(pdf|png|jpe?g|webp|bmp|gif)$/iu.test(file.name)) throw new Error(`Formato não suportado: ${file.name}.`);
      element('operation').textContent = `Lendo ${file.name}...`;
      const pdf = /\.pdf$/iu.test(file.name);
      let count = 1;
      let cover;
      if (pdf) {
        const opened = await openPDF(file);
        try {
          count = opened.pdf.numPages;
          cover = await renderCover(file, opened.pdf);
        } finally { await opened.destroy(); }
      } else cover = await renderCover(file);
      staged.push({
        id: ++nextId, file, pdf, count, cover, title: file.name,
        name: images.uniqueName(images.appName(file.name), used),
        colors: 'color', resolution: 960,
      });
    }
  } catch (error) {
    for (const source of staged) URL.revokeObjectURL(source.cover);
    throw error;
  }
  documents.push(...staged);
  for (const source of staged) {
    for (let number = 1; number <= source.count; number++) {
      pages.push({ id: `${source.id}:${number}`, documentId: source.id, number });
    }
  }
  invalidate();
  renderDocuments();
  renderPages();
  element('operation').textContent = `${staged.length} arquivo(s) adicionado(s), com todas as páginas incluídas. Envie à Prime ou baixe os apps.`;
  element('files').value = '';
  element('next-step').focus({ preventScroll: true });
  element('next-step').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
}

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

function button(text, title, action, className = 'quiet') {
  const result = node('button', className, text);
  result.type = 'button';
  result.title = title;
  result.setAttribute('aria-label', title);
  result.addEventListener('click', () => { if (!busy && !suppressPreviewClick) run(action); });
  return result;
}

function openDocument(id) {
  if (busy) return;
  finishPageDrag(false);
  organizerDocumentId = id;
  organizerAllPages = false;
  for (const page of pages) delete page.thumbnailError;
  renderDocuments();
  renderPages();
}

function renderDocuments() {
  // Keep the shared editor and its listeners when rebuilding document cards.
  element('editor-tools').append(element('page-tray'));
  element('page-tray').hidden = true;
  element('documents').replaceChildren();
  const active = currentDocument();
  if (!active) organizerDocumentId = undefined;
  for (const source of documents) {
    const selected = pages.filter(page => page.documentId === source.id);
    const item = node('li', 'document');
    const dropdown = node('details', 'document-dropdown');
    dropdown.open = source === active;
    const summary = node('summary', 'document-summary');
    summary.setAttribute('aria-label', `Configurações de ${source.title}`);
    summary.addEventListener('click', event => {
      event.preventDefault();
      if (busy) return;
      openDocument(source.id === organizerDocumentId ? undefined : source.id);
      const card = Array.from(element('documents').children).find(card => card.dataset.documentId === String(source.id));
      card?.querySelector('.document-summary')?.focus({ preventScroll: true });
    });
    item.dataset.documentId = String(source.id);
    const cover = node('img', 'document-cover');
    cover.src = source.cover;
    cover.alt = '';
    const identity = node('span', 'document-identity');
    identity.append(node('strong', '', source.title),
      node('small', '', `${selected.length} de ${source.count} página(s) · ${formatBytes(source.file.size)}`));
    const quality = node('span', 'document-quality', source.colors === 'color' && source.resolution === 960 && source.maximumColors === undefined
      ? 'Configurações padrão' : 'Configurações personalizadas');
    const action = node('span', 'document-toggle', source === active ? 'Fechar ajustes' : 'Ajustar');
    const chevron = node('span', 'document-chevron', '⌄');
    chevron.setAttribute('aria-hidden', 'true');
    summary.append(cover, identity, quality, action, chevron);
    dropdown.append(summary);
    const nameLabel = node('label', 'document-name-field', 'Nome do app');
    nameLabel.hidden = mode() === 'combined';
    const nameInput = node('input');
    nameInput.type = 'text';
    nameInput.value = source.name;
    nameInput.maxLength = 32;
    nameInput.setAttribute('aria-label', `Nome do app para ${source.title}`);
    nameInput.addEventListener('input', () => { source.name = nameInput.value; invalidate(); });
    nameInput.addEventListener('change', () => {
      const used = new Set(documents.filter(other => other !== source).map(other => other.name.toLowerCase()));
      source.name = images.uniqueName(images.appName(`${nameInput.value}.app`, 32), used);
      nameInput.value = source.name;
      invalidate();
    });
    nameLabel.append(nameInput);
    if (source === active) {
      element('page-tray').hidden = false;
      element('document-range').value = source.rangeDraft ?? images.pageRangeText(selected.map(page => page.number));
      element('document-range').setAttribute('aria-label', `Intervalo de páginas de ${source.title}`);
      element('colors').value = source.colors;
      element('resolution').value = source.customResolution ? 'custom' : String(source.resolution);
      element('custom-resolution').value = String(source.resolution);
      element('custom-resolution-label').hidden = !source.customResolution;
      element('palette').value = source.maximumColors === undefined ? 'default' : 'custom';
      element('custom-colors').value = String(source.maximumColors ?? (source.colors === 'gray' ? 32 : 256));
      element('custom-colors-label').hidden = source.maximumColors === undefined;
      dropdown.append(element('page-tray'));
    }
    item.append(nameLabel, dropdown);
    element('documents').append(item);
  }
  update();
}

function movePage(id, targetId) {
  const from = pages.findIndex(page => page.id === id);
  const to = pages.findIndex(page => page.id === targetId);
  if (from < 0 || to < 0 || from === to) return;
  if (mode() === 'separate' && pages[from].documentId !== pages[to].documentId) {
    throw new Error('No modo separado, ordene páginas dentro do mesmo arquivo. Para misturar arquivos, escolha Juntar em um app.');
  }
  pages.splice(to, 0, pages.splice(from, 1)[0]);
  invalidate();
  renderDocuments();
  renderPages();
}

function organizerPages() {
  return mode() === 'combined' && organizerAllPages ? pages : pages.filter(page => page.documentId === organizerDocumentId);
}

function rotatePage(page) {
  page.rotation = ((page.rotation ?? 0) + 90) % 360;
  discard(page);
  delete page.url;
  delete page.content;
  delete page.key;
  invalidate();
  renderPages();
}

function pageImage(page) {
  const source = documents.find(item => item.id === page.documentId);
  return page.url || page.thumbnail || (page.number === 1 ? source.cover : undefined);
}

function fillPageThumbnail(card, page) {
  const thumb = card.querySelector('.page-thumb');
  const url = pageImage(page);
  thumb.dataset.unavailable = url ? 'false' : 'true';
  thumb.disabled = busy || !url;
  thumb.replaceChildren();
  if (url) {
    const image = node('img');
    image.src = url;
    image.alt = `Página ${page.number}`;
    image.draggable = false;
    image.loading = 'lazy';
    if (!page.url) image.style.transform = `rotate(${page.rotation ?? 0}deg)`;
    thumb.append(image);
  } else thumb.append(node('span', 'page-placeholder', String(page.number)));
}

function observeThumbnails() {
  thumbnailObserver?.disconnect();
  if (element('page-tray').hidden || typeof IntersectionObserver === 'undefined') return;
  const generation = thumbnailGeneration;
  thumbnailObserver = new IntersectionObserver(entries => {
    const batch = [];
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      thumbnailObserver.unobserve(entry.target);
      const page = pages.find(page => page.id === entry.target.dataset.pageId);
      if (!page || pageImage(page) || pendingThumbnails.has(page.id) || page.thumbnailError) continue;
      pendingThumbnails.set(page.id, generation);
      batch.push(page);
    }
    if (!batch.length) return;
    thumbnailWork = thumbnailWork.then(async () => {
      const opened = new Map();
      try {
        for (const page of batch) {
          if (generation !== thumbnailGeneration) break;
          const source = documents.find(item => item.id === page.documentId);
          if (!source || !pages.includes(page)) continue;
          if (!opened.has(source.id)) opened.set(source.id, await openPDF(source.file));
          const url = await renderCover(source.file, opened.get(source.id).pdf, page.number);
          if (generation !== thumbnailGeneration || !pages.includes(page)) {
            URL.revokeObjectURL(url);
            continue;
          }
          page.thumbnail = url;
          const card = Array.from(element('previews').children).find(card => card.dataset.pageId === page.id);
          if (card) fillPageThumbnail(card, page);
        }
      } catch (error) {
        if (generation === thumbnailGeneration) {
          for (const page of batch) page.thumbnailError = true;
          element('organizer-status').textContent = `Falha ao carregar miniaturas: ${error.message}. Reabra o organizador para tentar novamente.`;
        }
        log(`Miniaturas: ${error.message}`);
      } finally {
        for (const page of batch) if (pendingThumbnails.get(page.id) === generation) pendingThumbnails.delete(page.id);
        for (const task of opened.values()) await task.destroy();
      }
    }).catch(error => {
      element('organizer-status').textContent = `Erro ao encerrar miniaturas: ${error.message}.`;
      log(`Miniaturas: ${error.message}`);
    });
  }, { rootMargin: '200px' });
  for (const card of element('previews').children) thumbnailObserver.observe(card);
}

function finishPageDrag(commit) {
  if (!pageDrag) return;
  const drag = pageDrag;
  pageDrag = undefined;
  cancelAnimationFrame(drag.frame);
  drag.ghost?.remove();
  drag.card.classList.remove('dragging');
  if (drag.capture.hasPointerCapture(drag.pointerId)) drag.capture.releasePointerCapture(drag.pointerId);
  if (!drag.active) return;
  if (!commit) pages = drag.original;
  else if (pages.some((page, index) => page !== drag.original[index])) invalidate();
  suppressPreviewClick = true;
  setTimeout(() => { suppressPreviewClick = false; }, 0);
  element('reorder-status').textContent = commit ? 'Ordem das páginas atualizada.' : 'Arraste cancelado. Ordem anterior restaurada.';
  renderDocuments();
  renderPages();
}

function updatePageDrag() {
  const drag = pageDrag;
  if (!drag?.active) return;
  drag.ghost.style.transform = `translate(${drag.x - drag.offsetX}px, ${drag.y - drag.offsetY}px)`;
  const bounds = element('previews').getBoundingClientRect();
  if (drag.x < bounds.left || drag.x > bounds.right || drag.y < bounds.top || drag.y > bounds.bottom) return;
  let nearest = 0;
  let distance = Infinity;
  drag.slots.forEach((slot, index) => {
    const value = (drag.x + scrollX - slot.x) ** 2 + (drag.y + scrollY - slot.y) ** 2;
    if (value < distance) { distance = value; nearest = index; }
  });
  const visible = organizerPages();
  const from = visible.findIndex(page => page.id === drag.id);
  if (from === nearest) return;
  const target = visible[nearest];
  const sourceIndex = pages.findIndex(page => page.id === drag.id);
  const targetIndex = pages.indexOf(target);
  pages.splice(targetIndex, 0, pages.splice(sourceIndex, 1)[0]);
  const cards = Array.from(element('previews').children);
  const targetCard = cards.find(card => card.dataset.pageId === target.id);
  element('previews').insertBefore(drag.card, from < nearest ? targetCard.nextSibling : targetCard);
}

function startPageDrag(event, card, page) {
  if (busy || event.button !== 0 || (event.target.closest('button') && !event.target.closest('.page-thumb'))) return;
  pageDrag = { id: page.id, card, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
    x: event.clientX, y: event.clientY, original: pages.slice(), active: false, capture: element('previews') };
}

function movePageDrag(event) {
  const drag = pageDrag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.x = event.clientX;
  drag.y = event.clientY;
  if (!drag.active) {
    if (Math.hypot(drag.x - drag.startX, drag.y - drag.startY) < 6) return;
    const rect = drag.card.getBoundingClientRect();
    drag.active = true;
    drag.capture.setPointerCapture(drag.pointerId);
    drag.offsetX = drag.startX - rect.left;
    drag.offsetY = drag.startY - rect.top;
    drag.slots = Array.from(element('previews').children, card => {
      const rect = card.getBoundingClientRect();
      return { x: rect.left + rect.width / 2 + scrollX, y: rect.top + rect.height / 2 + scrollY };
    });
    drag.ghost = drag.card.cloneNode(true);
    drag.ghost.inert = true;
    drag.ghost.className = 'page drag-ghost';
    drag.ghost.setAttribute('aria-hidden', 'true');
    drag.ghost.style.width = `${rect.width}px`;
    drag.ghost.style.height = `${rect.height}px`;
    document.body.append(drag.ghost);
    drag.card.classList.add('dragging');
    const scroll = () => {
      if (pageDrag !== drag) return;
      const delta = drag.y < 80 ? -16 : drag.y > innerHeight - 80 ? 16 : 0;
      if (delta) { scrollBy(0, delta); updatePageDrag(); }
      drag.frame = requestAnimationFrame(scroll);
    };
    drag.frame = requestAnimationFrame(scroll);
  }
  event.preventDefault();
  updatePageDrag();
}

function renderPages() {
  const scope = `${mode()}:${organizerDocumentId ?? ''}:${organizerAllPages}:${element('page-tray').hidden}`;
  if (scope !== thumbnailScope) {
    thumbnailScope = scope;
    thumbnailGeneration++;
    pendingThumbnails.clear();
  }
  thumbnailObserver?.disconnect();
  const selected = currentDocument();
  if (!selected) organizerDocumentId = undefined;
  element('organizer-title').textContent = organizerAllPages ? 'Todas as páginas do app' : 'Páginas deste documento';
  element('organizer-scope').hidden = mode() !== 'combined';
  element('organizer-scope').textContent = organizerAllPages ? 'Somente este documento' : 'Ordenar entre documentos';
  element('organizer-status').textContent = !organizerPages().length
    ? 'Nenhuma página selecionada. Ajuste o intervalo acima.'
    : 'Arraste para ordenar · gire ou exclua. Esc cancela o arraste.';
  element('previews').replaceChildren();
  element('previews').hidden = !selected;
  for (const page of organizerPages()) {
    const source = documents.find(item => item.id === page.documentId);
    const peers = organizerPages();
    const index = peers.indexOf(page);
    const item = node('li', 'page');
    item.draggable = false;
    item.dataset.pageId = page.id;
    item.tabIndex = 0;
    item.setAttribute('aria-label', `${source.title}, página ${page.number}. Arraste para ordenar; Alt e setas para ordenar pelo teclado.`);
    item.addEventListener('keydown', event => {
      if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key) || busy) return;
      event.preventDefault();
      const target = peers[index + (event.key === 'ArrowLeft' ? -1 : 1)];
      if (target) {
        movePage(page.id, target.id);
        const card = Array.from(element('previews').children).find(card => card.dataset.pageId === page.id);
        card?.focus({ preventScroll: true });
        element('reorder-status').textContent = 'Ordem das páginas atualizada.';
      }
    });
    item.addEventListener('pointerdown', event => startPageDrag(event, item, page));
    item.addEventListener('dragstart', event => event.preventDefault());
    const thumb = button(String(page.number), `Ampliar ${source.title}, página ${page.number}`, () => {
      element('preview-title').textContent = `${source.title} · página ${page.number}`;
      element('preview-image').src = pageImage(page);
      element('preview-image').style.transform = page.url ? '' : `rotate(${page.rotation ?? 0}deg)`;
      element('preview-description').textContent = page.url ? 'PNG final que será enviado à Prime.'
        : 'Miniatura de organização. Use Aplicar para gerar o PNG final.';
      element('preview-image').alt = `PNG preparado de ${source.title}, página ${page.number}`;
      element('preview-dialog').showModal();
    }, 'page-thumb');
    const controls = node('div', 'page-controls');
    controls.append(button('Girar 90°', `Girar página ${page.number} de ${source.title}`, () => rotatePage(page), 'secondary'),
      button('Excluir', `Remover página ${page.number} de ${source.title}`, () => {
      discard(page, true);
      pages = pages.filter(other => other !== page);
      invalidate();
      renderDocuments();
      renderPages();
    }, 'quiet danger'));
    item.append(thumb, node('p', '', `${index + 1}. ${source.title} · p. ${page.number}`),
      node('small', '', page.content ? `${page.width} × ${page.height} · ${formatBytes(page.content.length)}` : `Rotação: ${page.rotation ?? 0}°`), controls);
    fillPageThumbnail(item, page);
    element('previews').append(item);
  }
  update();
  observeThumbnails();
}

function renderApps() {
  element('apps').replaceChildren();
  for (const app of prepared) {
    const item = node('li', `app-row${app.status === 'error' ? ' error' : ''}`);
    const details = node('div');
    details.append(node('strong', '', app.name), node('small', '',
      `${app.pageCount} página(s) · maior página aberta: ~${formatBytes(app.maxRam)} em pixels`));
    const result = node('div', 'app-result');
    result.append(node('strong', 'app-size', formatBytes(app.filesBytes ?? app.bytes)),
      node('small', '', app.filesBytes === undefined ? `${app.bytes.toLocaleString('pt-BR')} bytes · mensagem USB completa`
        : `${app.filesBytes.toLocaleString('pt-BR')} bytes na pasta · ${formatBytes(app.bytes)} via USB`),
      node('span', `app-status ${app.status}`, ({ ready: 'Pronto', sending: 'Enviando…', processing: 'Gravando na Prime…',
        sent: 'Enviado', error: 'Envio interrompido' })[app.status]));
    item.append(details, result);
    element('apps').append(item);
  }
  element('result-summary').hidden = prepared.length === 0;
  element('result-summary').textContent = prepared.map(app => {
    const size = app.filesBytes ?? app.bytes;
    return `${app.name}: ${formatBytes(size)} (${size.toLocaleString('pt-BR')} bytes)`;
  }).join(' · ');
  update();
}

function checkCancelled() {
  if (cancelled) throw new Error('Preparação cancelada. A seleção foi preservada; nenhum app foi enviado.');
}

async function prepare({ forUSB = true } = {}) {
  for (const source of documents) {
    if (!Number.isInteger(source.resolution) || source.resolution < 64 || source.resolution > 2048) {
      throw new Error(`${source.title}: escolha uma resolução inteira entre 64 e 2048 px.`);
    }
    if (source.maximumColors !== undefined &&
        (!Number.isInteger(source.maximumColors) || source.maximumColors < 2 || source.maximumColors > 256)) {
      throw new Error(`${source.title}: escolha uma quantidade inteira entre 2 e 256 cores.`);
    }
  }
  const pendingRanges = documents.filter(source => source.rangeDraft !== undefined);
  for (const source of pendingRanges) images.pageRange(source.rangeDraft, source.count);
  for (const source of pendingRanges) selectPages(source.id, source.rangeDraft);
  invalidate('Preparando páginas selecionadas...');
  const groups = images.groups(documents, pages, mode(), element('name').value);
  if (!groups.length) throw new Error('Selecione pelo menos uma página.');
  preparing = true;
  cancelled = false;
  update();
  try {
    const model = await loadTemplate();
    checkCancelled();
    let count = 0;
    let totalBytes = 0;
    for (const source of documents) {
      checkCancelled();
      const maximum = source.resolution;
      const key = settingsKey(source);
      const selected = pages.filter(page => page.documentId === source.id);
      if (!selected.length) continue;
      const missing = selected.filter(page => page.key !== key || (page.renderedRotation ?? 0) !== (page.rotation ?? 0));
      let opened;
      let bitmap;
      try {
        if (missing.length) {
          if (source.pdf) opened = await openPDF(source.file);
          else bitmap = await createImageBitmap(source.file);
        }
        for (const page of selected) {
          checkCancelled();
          element('operation').textContent = `Preparando ${count + 1}/${pages.length}: ${source.title}, página ${page.number}...`;
          if (page.key !== key || (page.renderedRotation ?? 0) !== (page.rotation ?? 0)) {
            const pdfPage = opened ? await opened.pdf.getPage(page.number) : null;
            let canvas;
            try {
              const rotation = page.rotation ?? 0;
              const original = pdfPage ? pdfPage.getViewport({ scale: 1, rotation: (pdfPage.rotate ?? 0) + rotation }) : bitmap;
              const scale = (pdfPage ? maximum : Math.min(maximum, Math.max(original.width, original.height))) /
                Math.max(original.width, original.height);
              canvas = document.createElement('canvas');
              const swap = !pdfPage && rotation % 180 !== 0;
              canvas.width = Math.max(1, Math.round((swap ? original.height : original.width) * scale));
              canvas.height = Math.max(1, Math.round((swap ? original.width : original.height) * scale));
              if (canvas.width * canvas.height > 4 * 1048576) throw new Error('Página excede 4 megapixels.');
              const context = canvas.getContext('2d', { willReadFrequently: true });
              if (!context) throw new Error('Não foi possível criar o canvas de conversão.');
              if (pdfPage) {
                await pdfPage.render({
                  canvasContext: context, viewport: pdfPage.getViewport({ scale, rotation: (pdfPage.rotate ?? 0) + rotation }),
                  background: 'rgb(255,255,255)', intent: 'print',
                }).promise;
              } else {
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, canvas.width, canvas.height);
                context.imageSmoothingQuality = 'high';
                context.translate(canvas.width / 2, canvas.height / 2);
                context.rotate(rotation * Math.PI / 180);
                context.drawImage(bitmap, -original.width * scale / 2, -original.height * scale / 2,
                  original.width * scale, original.height * scale);
              }
              await new Promise(resolve => setTimeout(resolve, 0));
              checkCancelled();
              const content = images.encode(context.getImageData(0, 0, canvas.width, canvas.height).data,
                canvas.width, canvas.height, source.colors, source.maximumColors);
              discard(page);
              Object.assign(page, { content, width: canvas.width, height: canvas.height, key, renderedRotation: rotation,
                url: URL.createObjectURL(new Blob([content], { type: 'image/png' })) });
            } finally {
              if (canvas) canvas.width = canvas.height = 1;
              pdfPage?.cleanup();
            }
          }
          totalBytes += page.content.length;
          if (totalBytes > 32 * 1048576) throw new Error('A sessão preparada excede 32 MiB. Remova páginas ou reduza a resolução.');
          count++;
          element('progress').value = count / pages.length * 100;
        }
      } finally {
        if (opened) await opened.destroy();
        bitmap?.close();
      }
    }
    checkCancelled();
    const result = groups.map(group => {
      const app = { ...images.prepareApp(model, group.pages), name: group.name };
      const bytes = codec.fileMessage(0xf7, 2, app.name, codec.packApp(app)).length;
      if (forUSB && bytes > PROTOCOL2_MAX_BYTES) throw new Error(`${app.name}: ${formatBytes(bytes)} excedem 8 MiB por app. Selecione menos páginas, reduza a resolução ou baixe o app.`);
      const filesBytes = model.program ? app.descriptor.length + model.program.length +
        app.resources.reduce((sum, resource) => sum + resource.content.length, 0) : undefined;
      return { ...app, bytes, filesBytes, pageCount: group.pages.length,
        maxRam: Math.max(...group.pages.map(page => page.width * page.height * 2)), status: 'ready' };
    });
    prepared = result;
    element('package').textContent = `${result.length} app(s) · ${pages.length} página(s) · ${formatBytes(result.reduce((sum, app) => sum + app.bytes, 0))} no total via USB.`;
    element('operation').textContent = 'Apps preparados. Envie à Prime, baixe ou abra as configurações para conferir as prévias.';
    element('settings-status').className = 'connected';
    element('settings-status').textContent = `Configurações aplicadas a ${pages.length} página(s). Apps prontos para enviar ou baixar.`;
    log(`Preparados ${result.length} app(s), ${pages.length} páginas. Qualidade por documento; fonte e ícone originais preservados. Sem upload.`);
    renderApps();
  } finally {
    preparing = false;
    renderPages();
  }
}

element('choose').addEventListener('click', () => element('files').click());
element('files').addEventListener('change', () => run(() => addFiles(element('files').files)));
for (const name of ['dragenter', 'dragover']) element('dropzone').addEventListener(name, event => {
  event.preventDefault();
  if (!busy && event.dataTransfer.types.includes('Files')) element('dropzone').classList.add('dragging');
});
element('dropzone').addEventListener('dragleave', event => {
  if (!element('dropzone').contains(event.relatedTarget)) element('dropzone').classList.remove('dragging');
});
element('dropzone').addEventListener('drop', event => {
  event.preventDefault();
  element('dropzone').classList.remove('dragging');
  if (!busy) run(() => addFiles(event.dataTransfer.files));
});
document.addEventListener('dragover', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
document.addEventListener('drop', event => { if (event.dataTransfer.types.includes('Files')) event.preventDefault(); });
element('clear').addEventListener('click', () => {
  if (busy) return;
  for (const page of pages) discard(page, true);
  for (const source of documents) URL.revokeObjectURL(source.cover);
  pages = [];
  documents.length = 0;
  organizerDocumentId = undefined;
  organizerAllPages = false;
  invalidate('Seus apps preparados aparecerão aqui.');
  renderDocuments();
  renderPages();
});
for (const id of ['mode-separate', 'mode-combined']) element(id).addEventListener('change', () => {
  finishPageDrag(false);
  organizerAllPages = false;
  invalidate();
  renderDocuments();
  renderPages();
});
for (const id of ['colors', 'resolution', 'custom-resolution', 'palette', 'custom-colors']) element(id).addEventListener('change', () => {
  const source = currentDocument();
  if (busy || !source) return;
  source.colors = element('colors').value;
  source.customResolution = element('resolution').value === 'custom';
  source.resolution = Number(source.customResolution ? element('custom-resolution').value : element('resolution').value);
  if (element('palette').value === 'custom') source.maximumColors = Number(element('custom-colors').value);
  else delete source.maximumColors;
  for (const page of pages.filter(page => page.documentId === source.id)) {
    discard(page);
    delete page.content;
    delete page.url;
    delete page.key;
  }
  invalidate('Qualidade alterada. As imagens serão atualizadas ao enviar ou baixar.');
  renderDocuments();
  renderPages();
  element(id).focus({ preventScroll: true });
});
element('name').addEventListener('input', () => invalidate());
element('name').addEventListener('change', () => {
  element('name').value = images.appName(`${element('name').value}.app`, 32);
  invalidate();
});
element('document-range').addEventListener('input', () => {
  const source = currentDocument();
  if (busy || !source) return;
  source.rangeDraft = element('document-range').value;
  invalidate();
});
element('select-range').addEventListener('click', () => run(() => {
  selectPages(organizerDocumentId, element('document-range').value);
}));
element('document-range').addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    if (!busy) run(() => selectPages(organizerDocumentId, element('document-range').value));
  }
});
element('remove-document').addEventListener('click', () => run(() => {
  const source = currentDocument();
  for (const page of pages.filter(page => page.documentId === source.id)) discard(page, true);
  URL.revokeObjectURL(source.cover);
  pages = pages.filter(page => page.documentId !== source.id);
  documents.splice(documents.indexOf(source), 1);
  organizerDocumentId = undefined;
  organizerAllPages = false;
  invalidate();
  renderDocuments();
  renderPages();
}));
element('organizer-scope').addEventListener('click', () => {
  if (busy) return;
  finishPageDrag(false);
  organizerAllPages = !organizerAllPages;
  renderPages();
});
element('previews').addEventListener('pointermove', movePageDrag);
element('previews').addEventListener('pointerup', event => {
  if (pageDrag?.pointerId !== event.pointerId) return;
  const bounds = element('previews').getBoundingClientRect();
  finishPageDrag(event.clientX >= bounds.left && event.clientX <= bounds.right &&
    event.clientY >= bounds.top && event.clientY <= bounds.bottom);
});
element('previews').addEventListener('pointercancel', () => finishPageDrag(false));
element('previews').addEventListener('lostpointercapture', () => finishPageDrag(false));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && pageDrag) { event.preventDefault(); finishPageDrag(false); }
});
globalThis.addEventListener('resize', () => finishPageDrag(false));
element('prepare').addEventListener('click', () => run(async () => {
  await prepare({ forUSB: false });
  organizerDocumentId = undefined;
  organizerAllPages = false;
  renderDocuments();
  renderPages();
  element('delivery').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}));
element('cancel').addEventListener('click', () => { cancelled = true; update(); });
element('close-preview').addEventListener('click', () => element('preview-dialog').close());
element('download').addEventListener('click', () => run(async () => {
  if (!prepared.length) await prepare({ forUSB: false });
  const bytes = images.archive(prepared, await loadTemplate());
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
  const link = node('a');
  link.href = url;
  link.download = prepared.length === 1 ? `${prepared[0].name}.hpappdir.zip` : 'Apps_HP_Prime.zip';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  element('operation').textContent = 'Download ZIP gerado. Extraia para obter as pastas .hpappdir. Nenhum app foi enviado à calculadora.';
}));
element('send').addEventListener('click', () => run(async () => {
  if (!identified || !connection || connection.error) throw new Error('Conecte a Prime antes de enviar, ou use Baixar .hpappdir.');
  if (!prepared.length) await prepare();
  if (prepared.some(app => app.bytes > connection.maxSendBytes)) throw new Error('App excede o limite de envio USB. Reduza a seleção ou baixe o app.');
  const pending = prepared.filter(app => app.status !== 'sent');
  if (!pending.length) throw new Error('Todos os apps desta fila já foram enviados. Prepare novamente para reenviar.');
  const totalBytes = pending.reduce((sum, app) => sum + app.bytes, 0);
  const offsets = new Map();
  let offset = 0;
  for (const app of pending) { offsets.set(app, offset); offset += app.bytes; }
  let lastPaint = 0;
  const started = performance.now();
  try {
    await connection.installMany(pending, true, {
      onProgress: (app, sent, total) => {
        const now = performance.now();
        if (sent !== total && now - lastPaint < 50) return;
        lastPaint = now;
        element('progress').value = (offsets.get(app) + sent) / totalBytes * 100;
        element('operation').textContent = `Enviando ${pending.indexOf(app) + 1}/${pending.length} · ${app.name}: ${formatBytes(sent)} / ${formatBytes(total)}.`;
      },
      onStatus: (app, status) => {
        if (status === 'preflight') {
          element('operation').textContent = 'Consultando prontidão da Prime. Cada app será enviado uma única vez.';
        } else {
          app.status = status;
          if (status === 'processing') element('operation').textContent = `${app.name}: aguardando a Prime gravar o app.`;
          if (status === 'sent') log(`Enviado: ${app.name}. Sem releitura de conferência.`);
          renderApps();
        }
      },
    });
  } catch (error) {
    for (const app of pending) {
      if (['sending', 'processing'].includes(app.status)) app.status = 'error';
    }
    renderApps();
    throw new Error(`${error.message}. Apps já enviados foram mantidos e não serão reenviados automaticamente; os ainda pendentes não foram enviados.`, { cause: error });
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  element('operation').textContent = `Enviado: ${pending.length} app(s) em ${seconds} s, sem releitura de conferência. Abra-os em Apps na sua Prime.`;
  log(`Fila concluída em ${seconds} s: ${pending.length} envio(s), sem releitura de conferência.`);
}));

update();
if (supported) run(async () => {
  const devices = (await navigator.hid.getDevices()).filter(device =>
    device.vendorId === 0x03f0 && [0x0441, 0x1541, 0x2441].includes(device.productId));
  if (devices.length === 1) await connect(devices[0]);
  else if (devices.length > 1) log('Mais de uma Prime autorizada. Escolha uma pelo botão Conectar.');
});
