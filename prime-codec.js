(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.HPPrimeCodec = factory();
})(globalThis, function () {
  'use strict';

  const MAX_SEND_BYTES = 63 * 255;
  const bytes = value => typeof Buffer === 'function' ? Buffer.from(value) : Uint8Array.from(value);
  const allocate = size => bytes(new Uint8Array(size));
  const view = data => new DataView(data.buffer, data.byteOffset, data.byteLength);
  const equal = (left, right) => left.length === right.length && left.every((byte, i) => byte === right[i]);
  const concat = arrays => {
    const result = allocate(arrays.reduce((size, data) => size + data.length, 0));
    let offset = 0;
    for (const data of arrays) {
      result.set(data, offset);
      offset += data.length;
    }
    return result;
  };
  const utf16 = text => {
    const result = allocate(text.length * 2);
    for (let i = 0; i < text.length; i++) view(result).setUint16(i * 2, text.charCodeAt(i), true);
    return result;
  };
  const text = data => new TextDecoder('utf-16le', { fatal: true }).decode(data);
  const magic = data => equal(data.subarray(0, 4), [0x7c, 0x61, 0x8a, 0xb2]);

  function sourceRecord(container) {
    if (!magic(container)) throw new Error('Contêiner HP invalido.');
    const candidates = [];
    const data = view(container);
    for (let offset = 12; offset + 8 <= container.length; offset++) {
      const size = data.getUint32(offset, true);
      if (data.getUint32(offset + 4, true) !== 0x00c0009b ||
          size < 4 || size % 2 || offset + 4 + size > container.length) continue;
      const start = offset + 8;
      const end = offset + 4 + size;
      const source = text(container.subarray(start, end)).replace(/\0+$/u, '');
      if (source.includes('\0')) throw new Error('NUL interno no fonte HP PPL.');
      candidates.push({ offset, start, end, text: source });
    }
    if (candidates.length !== 1) throw new Error('Esperado um unico registro de fonte HP PPL.');
    return candidates[0];
  }

  function packApp({ descriptor, note, source, resources }) {
    if (!magic(descriptor)) throw new Error('Descritor .hpapp invalido.');
    if (source.includes('\0')) throw new Error('Fonte nao pode conter NUL.');
    const blocks = [descriptor, note, utf16(source + '\0')];
    const names = new Set();
    for (const { name, content } of resources) {
      if (!name || name.includes('\0') || /[/\\]/u.test(name) || names.has(name)) {
        throw new Error(`Nome de recurso invalido ou duplicado: ${name}`);
      }
      names.add(name);
      blocks.push(concat([utf16(name + '\0'), content]));
    }
    return concat(blocks.map(block => {
      const size = allocate(4);
      view(size).setUint32(0, block.length);
      return concat([size, block]);
    }));
  }

  function unpackApp(content) {
    const blocks = [];
    for (let offset = 0; offset < content.length;) {
      if (offset + 4 > content.length) throw new Error('Pacote de app truncado.');
      const size = view(content).getUint32(offset);
      if (offset + 4 + size > content.length) throw new Error('Componente do app truncado.');
      blocks.push(content.subarray(offset + 4, offset + 4 + size));
      offset += 4 + size;
    }
    if (blocks.length < 3 || !magic(blocks[0])) throw new Error('Pacote de app invalido.');
    const source = text(blocks[2]).replace(/\0+$/u, '');
    if (source.includes('\0')) throw new Error('Fonte de app com NUL interno.');
    const resources = blocks.slice(3).map(block => {
      let end = 0;
      while (end + 1 < block.length && view(block).getUint16(end, true) !== 0) end += 2;
      if (end + 1 >= block.length) throw new Error('Recurso sem terminador de nome.');
      return { name: text(block.subarray(0, end)), content: block.subarray(end + 2) };
    });
    return { descriptor: blocks[0], note: blocks[1], source, resources };
  }

  function crc16(data) {
    let crc = 0;
    for (const byte of data) {
      crc ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 0xffff;
    }
    return crc;
  }

  function fileMessage(command, type, name, content = allocate(0)) {
    if (![0xf7, 0xf8].includes(command) || !Number.isInteger(type) || type < 0 || type > 11) {
      throw new Error('Comando ou tipo de arquivo USB invalido.');
    }
    const encodedName = utf16(name);
    if (!encodedName.length || encodedName.length > 254 || name.includes('\0')) {
      throw new Error('Nome USB invalido (1 a 127 unidades UTF-16).');
    }
    const message = allocate(10 + encodedName.length + content.length);
    message[0] = command;
    message[1] = 1;
    view(message).setUint32(2, message.length - 6);
    message[6] = type;
    message[7] = encodedName.length;
    message.set(encodedName, 10);
    message.set(content, 10 + encodedName.length);
    view(message).setUint16(8, crc16(message.subarray(0, message.length - 6)), true);
    return message;
  }

  function fragmentMessage(message, reportBytes = 64) {
    if (![64, 1024].includes(reportBytes)) throw new Error('Envio bloqueado: tamanho HID não suportado.');
    const payloadBytes = reportBytes - 1;
    const maximum = payloadBytes * 255;
    if (!message.length || message.length > maximum) {
      throw new Error(`Envio de ${message.length} bytes bloqueado: continuacao acima de ${maximum} bytes ainda nao validada neste firmware.`);
    }
    const reports = [];
    for (let offset = 0, sequence = 0; offset < message.length; offset += payloadBytes, sequence++) {
      reports.push(concat([bytes([0, sequence]), message.subarray(offset, offset + payloadBytes)]));
    }
    return reports;
  }

  function parseFile(message) {
    if (message[0] === 0xf9) return null;
    if (message.length < 10 || message[0] !== 0xf7 || message[1] !== 1 ||
        view(message).getUint32(2) !== message.length - 6) {
      throw new Error('Resposta de arquivo USB invalida.');
    }
    const nameLength = message[7];
    if (nameLength % 2 || 10 + nameLength > message.length) throw new Error('Comprimento do nome USB invalido.');
    const covered = bytes(message.subarray(0, message.length - 6));
    if (covered.length > 8) covered[8] = 0;
    if (covered.length > 9) covered[9] = 0;
    if (crc16(covered) !== view(message).getUint16(8, true)) throw new Error('CRC USB incorreto.');
    return {
      type: message[6],
      name: text(message.subarray(10, 10 + nameLength)).replace(/\0+$/u, ''),
      content: message.subarray(10 + nameLength),
    };
  }

  function limitTest(size, { guided = false, protocol2 = false } = {}) {
    if (guided && protocol2) throw new Error('Modos de teste incompatíveis.');
    if (guided ? !Number.isInteger(size) || size < 1024 || size > 16384 || size % 2 !== 0
      : !(protocol2 ? [16384, 32768, 51200, 1048576, 2097152, 4194304] : [16384, 32768, 51200]).includes(size)) {
      throw new Error('Tamanho de teste não autorizado.');
    }
    const name = guided ? `HPBusca${String(size).padStart(5, '0')}`
      : `${protocol2 ? 'HPProto' : 'HPTeste'}${size / 1024}KiB`;
    const content = allocate(size - 10 - name.length * 2);
    let random = 123456789;
    for (let offset = 0; offset < content.length - 2; offset += 2) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      content[offset] = offset % 128 === 126 ? 10 : 32 + random % 95;
    }
    const message = fileMessage(0xf7, 5, name, content);
    const reports = [];
    if (protocol2) return { name, content, message, reports };
    for (let offset = 0, index = 0; offset < size; offset += 63, index++) {
      reports.push(concat([bytes([0, index % 255]), message.subarray(offset, offset + 63)]));
    }
    return { name, content, message, reports };
  }

  return { MAX_SEND_BYTES, sourceRecord, packApp, unpackApp, crc16, fileMessage, fragmentMessage, parseFile, equal, concat, limitTest };
});
