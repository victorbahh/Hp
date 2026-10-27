(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./prime-codec.js'));
  else root.HPPrimeWebHID = factory(root.HPPrimeCodec);
})(globalThis, function (codec) {
  'use strict';

  const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  const PROTOCOL2_MAX_BYTES = 8 * 1024 * 1024;

  class Protocol2 {
    constructor(connection) {
      this.connection = connection;
      this.output = Promise.resolve();
      this.id = 0;
      this.outgoing = null;
      this.incoming = null;
      this.ackWaiter = null;
      this.negotiating = true;
    }

    fail(error) {
      this.incoming = null;
      if (this.ackWaiter) {
        this.ackWaiter.reject(error);
        this.ackWaiter = null;
      }
    }

    write(report) {
      const operation = this.output.then(async () => {
        if (this.connection.error) throw this.connection.error;
        let timer;
        try {
          await Promise.race([
            this.connection.device.sendReport(0, report),
            new Promise((resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Timeout de escrita USBPROT2. Reconecte o cabo.')), 10000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      });
      this.output = operation.catch(error => { this.connection.fail(error); });
      return operation;
    }

    acknowledge(incoming, sequence) {
      const report = new Uint8Array(this.connection.reportBytes);
      const data = new DataView(report.buffer);
      report.set([0xfe, 1, sequence]);
      data.setUint32(4, incoming.wireBytes, true);
      data.setUint32(8, incoming.id, true);
      this.write(report).catch(error => { this.connection.fail(error); });
    }

    accept(report) {
      const reportBytes = this.connection.reportBytes;
      if (report.length !== reportBytes) throw new Error(`USBPROT2 exige relatórios de ${reportBytes} bytes.`);
      const data = new DataView(report.buffer, report.byteOffset, report.byteLength);
      if (report[0] === 0xff) {
        if (report[7] !== 0 || this.incoming || this.outgoing) {
          throw new Error('Negociação USBPROT2 inesperada ou variante não suportada. Reconecte o cabo.');
        }
        this.connection.onControl(Array.from(report));
        return;
      }
      if (report[0] === 0xfe) {
        if (this.negotiating) {
          this.connection.onControl(Array.from(report));
          return;
        }
        const id = data.getUint32(8, true);
        const offset = data.getUint32(4, true);
        const outgoing = this.outgoing;
        // G2 can retain ACKs from earlier sessions; they never confirm the current ID.
        if (this.connection.reportBytes === 1024 && (!outgoing || id !== outgoing.id)) {
          this.connection.onControl(Array.from(report));
          return;
        }
        if (outgoing && id > 0 && id < outgoing.id) return;
        if (!outgoing && id > 0 && id <= this.id) return;
        if (!outgoing || id !== outgoing.id || report[1] !== 1 ||
            offset > outgoing.wireBytes || offset < outgoing.acknowledged) {
          throw new Error(`Confirmação USBPROT2 inválida: mensagem ${id}, posição ${offset}, estado ${report[1]}. Envio interrompido sem repetição automática.`);
        }
        outgoing.acknowledged = offset;
        if (this.ackWaiter && offset >= this.ackWaiter.target) {
          this.ackWaiter.resolve();
          this.ackWaiter = null;
        }
        return;
      }
      let start = 1;
      if (report[0] === 1) {
        if (this.incoming) throw new Error('Nova mensagem USBPROT2 antes de concluir a anterior.');
        const length = data.getUint32(5, true);
        if (!length || length > 128 * 1024 * 1024) throw new Error('Comprimento USBPROT2 inválido.');
        this.incoming = {
          id: data.getUint32(1, true), length, sequence: 1, wireBytes: 0,
          threshold: 76 * (reportBytes - 1), chunks: [],
        };
        start = 9;
      }
      const incoming = this.incoming;
      if (!incoming || report[0] !== incoming.sequence) {
        throw new Error('Quadro USBPROT2 fora de sequência. Reconecte o cabo.');
      }
      incoming.chunks.push(report.slice(start));
      incoming.wireBytes += reportBytes - start;
      const complete = incoming.wireBytes >= incoming.length;
      if (complete || incoming.wireBytes > incoming.threshold) {
        this.acknowledge(incoming, incoming.sequence);
        incoming.threshold = incoming.wireBytes + 76 * (reportBytes - 1);
      }
      incoming.sequence = incoming.sequence === 253 ? 2 : incoming.sequence + 1;
      if (complete) {
        this.incoming = null;
        this.connection.deliver(codec.concat(incoming.chunks).subarray(0, incoming.length));
      }
    }

    waitForAck(target) {
      if (this.connection.error) return Promise.reject(this.connection.error);
      if (this.outgoing.acknowledged >= target) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.connection.fail(new Error(`Timeout de confirmação USBPROT2 na posição ${target}. Reconecte o cabo; nada será reenviado automaticamente.`));
        }, 10000);
        this.ackWaiter = {
          target,
          resolve: () => { clearTimeout(timer); resolve(); },
          reject: error => { clearTimeout(timer); reject(error); },
        };
      });
    }

    async send(message, progress) {
      if (!message.length || message.length > PROTOCOL2_MAX_BYTES) {
        throw new Error(`Mensagem USBPROT2 fora do limite de segurança de ${PROTOCOL2_MAX_BYTES} bytes.`);
      }
      if (this.outgoing) throw new Error('Já existe um envio USBPROT2 pendente.');
      const outgoing = { id: ++this.id, wireBytes: 0, acknowledged: 0 };
      this.negotiating = false;
      this.outgoing = outgoing;
      let offset = 0;
      let sequence = 1;
      let window = 0;
      try {
        while (offset < message.length) {
          const report = new Uint8Array(this.connection.reportBytes);
          const start = sequence === 1 ? 9 : 1;
          report[0] = sequence;
          if (sequence === 1) {
            const data = new DataView(report.buffer);
            data.setUint32(1, outgoing.id, true);
            data.setUint32(5, message.length, true);
          }
          const count = Math.min(report.length - start, message.length - offset);
          report.set(message.subarray(offset, offset + count), start);
          outgoing.wireBytes += report.length - start;
          await this.write(report);
          // Bursting 1024-byte reports without pacing produced a NACK on the measured G2.
          if (this.connection.reportBytes === 1024) await delay(2);
          offset += count;
          progress(offset, message.length);
          if (++window === 77 || offset === message.length) {
            await this.waitForAck(outgoing.wireBytes);
            window = 0;
          }
          sequence = sequence === 253 ? 2 : sequence + 1;
        }
      } catch (error) {
        const failure = new Error(`Envio USBPROT2 interrompido após ${offset} de ${message.length} bytes; última confirmação na posição ${outgoing.acknowledged}. ${error.message}`, { cause: error });
        this.connection.fail(failure);
        throw failure;
      } finally {
        this.outgoing = null;
      }
    }
  }

  class LimitSearch {
    constructor() {
      this.next = 1024;
      this.passed = null;
      this.failed = null;
      this.done = false;
      this.halted = false;
    }

    record(accepted) {
      if (this.done || this.halted || typeof accepted !== 'boolean') {
        throw new Error('Resultado inválido ou busca encerrada.');
      }
      const size = this.next;
      if (accepted) this.passed = size;
      else this.failed = size;
      if (size === 1024 && !accepted) {
        this.halted = true;
        return;
      }
      if (this.failed !== null) {
        if (this.failed - this.passed <= 2) this.done = true;
        else this.next = this.passed + 2 * Math.floor((this.failed - this.passed) / 4);
      } else if (size === 1024) this.next = 16000;
      else if (size === 16000) this.next = 16384;
      else this.done = true;
    }
  }

  function validateDevice(device) {
    if (device.vendorId !== 0x03f0 || ![0x0441, 0x1541, 0x2441].includes(device.productId)) {
      throw new Error('O dispositivo selecionado não é uma HP Prime reconhecida.');
    }
    const input = [];
    const output = [];
    function visit(collection) {
      input.push(...(collection.inputReports ?? []));
      output.push(...(collection.outputReports ?? []));
      for (const child of collection.children ?? []) visit(child);
    }
    for (const collection of device.collections) visit(collection);
    const size = reports => reports.length === 1 && reports[0].reportId === 0
      ? reports[0].items.reduce((bits, item) => bits + item.reportSize * item.reportCount, 0) / 8 : 0;
    const reportBytes = size(input);
    if (![64, 1024].includes(reportBytes) || size(output) !== reportBytes) {
      const describe = reports => reports.length ? reports.map(report => {
        const bits = report.items.reduce((total, item) => total + item.reportSize * item.reportCount, 0);
        return `ID ${report.reportId}: ${bits / 8} bytes (${report.items.map(item => `${item.reportCount}×${item.reportSize} bits`).join(' + ')})`;
      }).join('; ') : 'nenhum relatório';
      const product = device.productId.toString(16).padStart(4, '0');
      throw new Error(`Descritor HID ainda não suportado pelo app: esperado um relatório de entrada e um de saída do mesmo tamanho (64 ou 1024 bytes), ambos com ID 0. ` +
        `USB 03f0:${product}. Entrada: ${describe(input)}. Saída: ${describe(output)}. ` +
        'Nenhum comando foi enviado por esta tentativa. Copie este diagnóstico para investigar a compatibilidade.');
    }
    return reportBytes;
  }

  class Connection {
    constructor(device, { onControl = () => {} } = {}) {
      this.reportBytes = validateDevice(device);
      if (!device.opened) throw new Error('Abra o dispositivo antes de criar a conexão.');
      this.device = device;
      this.onControl = onControl;
      this.messages = [];
      this.queuedBytes = 0;
      this.chunks = [];
      this.count = 0;
      this.sequence = 0;
      this.expected = undefined;
      this.error = null;
      this.protocol2 = null;
      this.protocol2VerifiedBytes = 0;
      this.waiter = null;
      this.lastReport = Date.now();
      this.input = event => {
        try {
          if (this.error) return;
          if (event.reportId !== 0) throw new Error('Report ID inesperado.');
          this.accept(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
        } catch (error) {
          this.fail(error);
        }
      };
      device.addEventListener('inputreport', this.input);
    }

    fail(error) {
      this.error = error;
      this.protocol2?.fail(error);
      this.messages.length = 0;
      this.chunks.length = 0;
      this.queuedBytes = 0;
      if (this.waiter) {
        this.waiter.reject(error);
        this.waiter = null;
      }
    }

    accept(report) {
      this.lastReport = Date.now();
      if (!report.length || report.length > this.reportBytes) throw new Error('Tamanho de relatório HID inválido.');
      if (this.protocol2) {
        this.protocol2.accept(report);
        return;
      }
      if (report[0] === 255 || (this.reportBytes === 1024 && report[0] === 254)) {
        this.onControl(Array.from(report));
        return;
      }
      if (report[0] !== this.sequence) {
        throw new Error(`Quadro fora de sequência: esperado ${this.sequence}, recebido ${report[0]}. Reconecte a HP Prime.`);
      }
      this.sequence = (this.sequence + 1) % 255;
      this.chunks.push(report.slice(1));
      this.count += report.length - 1;
      if (this.expected === undefined) {
        const first = codec.concat(this.chunks);
        if ([0x59, 0xff, 0xf9].includes(first[0])) this.expected = 1;
        else if (first.length >= 6) {
          if (first[1] !== 1) throw new Error('Cabeçalho USB desconhecido.');
          this.expected = new DataView(first.buffer, first.byteOffset, first.byteLength).getUint32(2) + 6;
          if (this.expected > 128 * 1024 * 1024) throw new Error('Comprimento de resposta excessivo.');
        }
      }
      if (this.expected !== undefined && this.count >= this.expected) {
        const message = codec.concat(this.chunks).slice(0, this.expected);
        this.chunks = [];
        this.count = 0;
        this.sequence = 0;
        this.expected = undefined;
        this.deliver(message);
      }
    }

    deliver(message) {
      if (this.waiter) {
        this.waiter.resolve(message);
        this.waiter = null;
      } else {
        this.queuedBytes += message.length;
        if (this.queuedBytes > 128 * 1024 * 1024) throw new Error('Fila de respostas excedida.');
        this.messages.push(message);
      }
    }

    receive(timeout = 10000) {
      if (this.error) return Promise.reject(this.error);
      if (this.messages.length) {
        const message = this.messages.shift();
        this.queuedBytes -= message.length;
        return Promise.resolve(message);
      }
      if (this.waiter) return Promise.reject(new Error('Já existe uma leitura USB pendente.'));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.fail(new Error('Timeout USB. Feche o Kit/outros clientes, reconecte o cabo e conecte novamente nesta página.'));
        }, timeout);
        this.waiter = {
          resolve: message => { clearTimeout(timer); resolve(message); },
          reject: error => { clearTimeout(timer); reject(error); },
        };
      });
    }

    async drain() {
      if (this.protocol2) await this.protocol2.output;
      const deadline = Date.now() + 5000;
      do {
        if (this.error) throw this.error;
        this.messages.length = 0;
        this.queuedBytes = 0;
        if (Date.now() - this.lastReport >= 100 && this.count === 0 && !this.protocol2?.incoming) return;
        if (Date.now() > deadline) throw new Error('USB ocupado ou resposta incompleta. Reconecte antes de continuar.');
        await delay(10);
      } while (true);
    }

    async send(message, progress = () => {}) {
      if (this.protocol2) return this.protocol2.send(message, progress);
      const reports = codec.fragmentMessage(message, this.reportBytes);
      await this.writeReports(message, reports, progress);
    }

    async writeReports(message, reports, progress) {
      let sent = 0;
      for (const report of reports) {
        if (this.error) throw this.error;
        // WebHID receives the report ID separately; only sequence + payload go in data.
        let timer;
        try {
          const data = this.reportBytes === 64 ? report.subarray(1) : new Uint8Array(this.reportBytes);
          if (this.reportBytes !== 64) data.set(report.subarray(1));
          await Promise.race([
            this.device.sendReport(0, data),
            new Promise((resolve, reject) => {
              timer = setTimeout(() => reject(new Error('Timeout de escrita USB. Reconecte o cabo antes de continuar.')), 10000);
            }),
          ]);
        } catch (error) {
          const failure = new Error(`Falha de escrita USB após ${sent} de ${message.length} bytes: ${error.message}. Confira o cabo e reconecte a calculadora.`, { cause: error });
          this.fail(failure);
          throw failure;
        } finally {
          clearTimeout(timer);
        }
        if (this.error) throw this.error;
        sent += report.length - 2;
        progress(sent, message.length);
        await delay(2);
      }
    }

    async testLimit(size, consent, progress = () => {}, options) {
      if (consent !== true) throw new Error('Autorize explicitamente o risco do teste de limite.');
      if (this.reportBytes !== 64) throw new Error('A busca antiga de limite exige relatórios de 64 bytes.');
      if (this.protocol2) throw new Error('A busca antiga exige o transporte antigo. Reconecte o cabo antes de usar essa busca.');
      const sample = codec.limitTest(size, options);
      await this.ready();
      let existing;
      await this.backup(object => {
        if (object.type === 5 && object.name === sample.name) existing = object.content;
      });
      if (existing !== undefined) {
        if (options?.guided === true) return this.verifyLimitNote(sample, existing, true);
        throw new Error(`A nota ${sample.name} já existe. Remova somente essa nota de teste manualmente antes de repetir; nada foi substituído.`);
      }
      await this.drain();
      await this.writeReports(sample.message, sample.reports, progress);
      await delay(1000);
      await this.ready();
      let received;
      await this.backup(object => {
        if (object.type === 5 && object.name === sample.name) received = object.content;
      });
      if (received === undefined) {
        const error = new Error(`Teste não verificado: a nota ${sample.name} (tipo 5) não foi encontrada na releitura de backup. O navegador concluiu a escrita de ${size} bytes, mas isso não comprova que a calculadora aceitou ou armazenou a nota.`);
        error.code = 'LIMIT_NOTE_MISSING';
        throw error;
      }
      return this.verifyLimitNote(sample, received, false);
    }

    async enableProtocol2(consent) {
      if (consent !== true) throw new Error('Autorize explicitamente o teste USBPROT2.');
      if (this.protocol2) return;
      if (this.reportBytes === 64) {
        await this.info();
        await this.drain();
      }
      this.protocol2 = new Protocol2(this);
      const negotiation = new Uint8Array(this.reportBytes);
      negotiation.set([0xff, 0xec]);
      await this.protocol2.write(negotiation);
      await this.ready();
    }

    async testProtocol2(size, consent, progress = () => {}) {
      if (consent !== true) throw new Error('Autorize explicitamente o teste USBPROT2.');
      const sample = codec.limitTest(size, { protocol2: true });
      const { name } = sample;
      await this.enableProtocol2(true);
      let existing;
      await this.backup(object => {
        if (object.type === 5 && object.name === name) existing = object.content;
      });
      if (existing !== undefined) {
        throw new Error(`A nota ${name} já existe. Nada foi substituído; remova apenas essa nota manualmente para repetir.`);
      }
      await this.drain();
      await this.send(sample.message, progress);
      await delay(1000);
      await this.ready();
      let received;
      await this.backup(object => {
        if (object.type === 5 && object.name === name) received = object.content;
      });
      if (received === undefined) throw new Error(`Teste USBPROT2 não verificado: nota ${name} ausente do backup.`);
      const result = this.verifyLimitNote(sample, received, false);
      this.protocol2VerifiedBytes = Math.max(this.protocol2VerifiedBytes, size);
      return result;
    }

    verifyLimitNote(sample, received, existing) {
      // This firmware appends one UTF-16 NUL to the already terminated note.
      const addedTerminator = received.length === sample.content.length + 2 &&
        received[received.length - 2] === 0 && received[received.length - 1] === 0 &&
        codec.equal(received.subarray(0, sample.content.length), sample.content);
      if (!codec.equal(received, sample.content) && !addedTerminator) {
        let different = 0;
        while (different < Math.min(received.length, sample.content.length) &&
               received[different] === sample.content[different]) different++;
        throw new Error(`Teste não verificado: nota ${sample.name} encontrada; esperados ${sample.content.length} bytes de conteúdo, recebidos ${received.length}; primeira divergência no byte ${different} (índice a partir de zero). A causa não foi determinada; não avance para o próximo tamanho.`);
      }
      return {
        name: sample.name, bytes: sample.message.length, contentBytes: sample.content.length,
        receivedBytes: received.length, addedTerminator, existing,
      };
    }

    async exchange(message) {
      await this.drain();
      await this.send(message);
      return this.receive();
    }

    async ready() {
      const reply = await this.exchange(Uint8Array.of(0xff));
      if (![0x59, 0xff].includes(reply[0])) throw new Error('A calculadora não confirmou prontidão.');
    }

    async info() {
      if (this.reportBytes === 1024 && !this.protocol2) await this.enableProtocol2(true);
      await this.ready();
      const reply = await this.exchange(Uint8Array.of(0xfa));
      if (reply[0] !== 0xfa || reply.length < 70) throw new Error('Resposta de identificação inválida.');
      const name = new TextDecoder('utf-16le', { fatal: true }).decode(reply.subarray(6, 70)).split('\0')[0];
      const firmware = new TextDecoder('latin1').decode(reply).match(/V\d+\.\d+\.\d+/u)?.[0];
      return { name, firmware: firmware ?? 'não identificado' };
    }

    async backup(onObject) {
      await this.drain();
      await this.send(Uint8Array.of(0xf9));
      for (let index = 0; index < 20000; index++) {
        const object = codec.parseFile(await this.receive(30000));
        if (!object) return;
        await onObject(object);
      }
      throw new Error('Limite de objetos excedido na leitura.');
    }

    get maxSendBytes() {
      return this.protocol2 ? PROTOCOL2_MAX_BYTES : (this.reportBytes - 1) * 255;
    }

    async install(app, replace, progress = () => {}) {
      return this.installMany([app], replace, { onProgress: (current, sent, total) => progress(sent, total) });
    }

    async installMany(apps, replace, { onProgress = () => {}, onStatus = () => {} } = {}) {
      if (!apps.length) throw new Error('Nenhum app selecionado para envio.');
      const names = new Set();
      const queue = apps.map(app => {
        if (names.has(app.name.toLowerCase())) throw new Error(`Nome de app repetido: ${app.name}.`);
        names.add(app.name.toLowerCase());
        const message = codec.fileMessage(0xf7, 2, app.name, codec.packApp(app));
        if (message.length > this.maxSendBytes) {
          throw new Error(`Envio de ${message.length} bytes bloqueado: limite deste transporte é ${this.maxSendBytes} bytes.`);
        }
        return { app, message };
      });
      onStatus(null, 'preflight');
      await this.ready();
      if (!replace) {
        const existing = new Set();
        await this.backup(object => {
          if (object.type === 2) existing.add(object.name.toLowerCase());
        });
        for (const { app } of queue) {
          if (existing.has(app.name.toLowerCase())) {
            throw new Error(`O app ${app.name} já existe. Autorize a substituição para continuar.`);
          }
        }
      }
      for (const { app, message } of queue) {
        try {
          await this.drain();
          onStatus(app, 'sending');
          await this.send(message, (sent, total) => onProgress(app, sent, total));
          onStatus(app, 'processing');
          await delay(1000);
          await this.ready();
          onStatus(app, 'sent');
        } catch (error) {
          onStatus(app, 'error');
          throw new Error(`Fila interrompida em ${app.name}: ${error.message}`, { cause: error });
        }
      }
    }

    async close() {
      if (this.protocol2) await this.protocol2.output;
      this.device.removeEventListener('inputreport', this.input);
      this.fail(new Error('Conexão encerrada.'));
      if (this.device.opened) await this.device.close();
    }
  }

  return { Connection, validateDevice, LimitSearch, PROTOCOL2_MAX_BYTES };
});
