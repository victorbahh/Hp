(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory({ ...require('fast-png'), zipSync: require('fflate').zipSync });
  else root.HPPrimeImages = factory(root.HPPrimePNG);
})(globalThis, function (png) {
  'use strict';

  function appName(filename, maximumLength = 20) {
    const name = filename.replace(/\.[^.]+$/u, '').normalize('NFD')
      .replace(/[\u0300-\u036f]/gu, '').replace(/[^A-Za-z0-9_]+/gu, '_').replace(/^_+|_+$/gu, '');
    return (/^[A-Za-z]/u.test(name) ? name : `Doc_${name || 'Imagens'}`).slice(0, maximumLength).replace(/_+$/u, '');
  }

  function encode(rgba, width, height, mode, maximumColors = mode === 'gray' ? 32 : 256) {
    if (!['gray', 'color'].includes(mode)) throw new Error('Modo de cor inválido.');
    if (!Number.isInteger(maximumColors) || maximumColors < 2 || maximumColors > 256) {
      throw new Error('Escolha entre 2 e 256 cores.');
    }
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
        width * height > 4 * 1024 * 1024 || rgba.length !== width * height * 4) {
      throw new Error('Dimensões de imagem inválidas ou acima de 4 megapixels.');
    }
    const rgb = new Uint8Array(width * height * 3);
    const histogram = new Map();
    for (let offset = 0; offset < rgba.length; offset += 4) {
      const alpha = rgba[offset + 3] / 255;
      let red = Math.round(rgba[offset] * alpha + 255 * (1 - alpha));
      let green = Math.round(rgba[offset + 1] * alpha + 255 * (1 - alpha));
      let blue = Math.round(rgba[offset + 2] * alpha + 255 * (1 - alpha));
      if (mode === 'gray') {
        const gray = Math.round((red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255 * (maximumColors - 1)) * 255 / (maximumColors - 1);
        red = green = blue = Math.round(gray);
      }
      const position = offset / 4 * 3;
      rgb.set([red, green, blue], position);
      const key = red * 65536 + green * 256 + blue;
      if (histogram.size <= 256 || histogram.has(key)) {
        histogram.set(key, (histogram.get(key) ?? 0) + 1);
      }
    }
    let palette;
    const pixels = new Uint8Array(width * height);
    if (histogram.size <= maximumColors) {
      palette = Array.from(histogram.keys(), key => [key >>> 16, (key >>> 8) & 255, key & 255]);
      const indices = new Map(Array.from(histogram.keys(), (key, index) => [key, index]));
      for (let i = 0; i < pixels.length; i++) {
        pixels[i] = indices.get(rgb[i * 3] * 65536 + rgb[i * 3 + 1] * 256 + rgb[i * 3 + 2]);
      }
    } else {
      const buckets = new Map();
      const neutrals = new Set();
      const neutralSteps = Math.min(32, maximumColors - 1) - 1;
      const neutralLevel = (r, g, b) => maximumColors >= 32 && Math.max(r, g, b) - Math.min(r, g, b) <= 3
        ? Math.round((r + g + b) / 3 / 255 * neutralSteps) : -1;
      for (let i = 0; i < rgb.length; i += 3) {
        const level = neutralLevel(rgb[i], rgb[i + 1], rgb[i + 2]);
        if (level !== -1) {
          neutrals.add(level);
          continue;
        }
        const key = (rgb[i] >> 3) * 1024 + (rgb[i + 1] >> 3) * 32 + (rgb[i + 2] >> 3);
        let bucket = buckets.get(key);
        if (!bucket) {
          bucket = { key, count: 0, sums: [0, 0, 0] };
          buckets.set(key, bucket);
        }
        bucket.count++;
        for (let c = 0; c < 3; c++) bucket.sums[c] += rgb[i + c];
      }
      const box = entries => {
        const ranges = [0, 1, 2].map(c => {
          let low = 255;
          let high = 0;
          for (const entry of entries) {
            const value = entry.sums[c] / entry.count;
            low = Math.min(low, value);
            high = Math.max(high, value);
          }
          return high - low;
        });
        const count = entries.reduce((sum, entry) => sum + entry.count, 0);
        const axis = ranges.indexOf(Math.max(...ranges));
        return { entries, count, axis, score: entries.length > 1 ? ranges[axis] * Math.sqrt(count) : 0 };
      };
      const boxes = buckets.size ? [box(Array.from(buckets.values()))] : [];
      while (boxes.length < maximumColors - neutrals.size && boxes.length) {
        let index = 0;
        for (let i = 1; i < boxes.length; i++) if (boxes[i].score > boxes[index].score) index = i;
        const current = boxes[index];
        if (!current.score) break;
        const { entries, axis, count } = current;
        entries.sort((a, b) => a.sums[axis] / a.count - b.sums[axis] / b.count);
        let accumulated = 0;
        let split = 0;
        do { accumulated += entries[split++].count; } while (split < entries.length - 1 && accumulated < count / 2);
        boxes.splice(index, 1, box(entries.slice(0, split)), box(entries.slice(split)));
      }
      const indices = new Map();
      palette = boxes.map((current, index) => {
        const sums = [0, 0, 0];
        for (const entry of current.entries) {
          indices.set(entry.key, index);
          for (let c = 0; c < 3; c++) sums[c] += entry.sums[c];
        }
        return sums.map(sum => Math.round(sum / current.count));
      });
      const neutralIndices = new Map();
      for (const level of Array.from(neutrals).sort((a, b) => a - b)) {
        neutralIndices.set(level, palette.length);
        const value = neutralSteps ? Math.round(level * 255 / neutralSteps) : 0;
        palette.push([value, value, value]);
      }
      for (let i = 0; i < pixels.length; i++) {
        const level = neutralLevel(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
        pixels[i] = level === -1
          ? indices.get((rgb[i * 3] >> 3) * 1024 + (rgb[i * 3 + 1] >> 3) * 32 + (rgb[i * 3 + 2] >> 3))
          : neutralIndices.get(level);
      }
    }
    const encoded = png.encode({ width, height, data: pixels, channels: 1, depth: 8, palette }, { zlib: { level: 9 } });
    if (palette.length > 16) return encoded;
    const stride = Math.ceil(width / 2);
    const packed = new Uint8Array(stride * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        packed[y * stride + (x >> 1)] |= pixels[y * width + x] << (x % 2 ? 0 : 4);
      }
    }
    const compact = png.encode({ width, height, data: packed, channels: 1, depth: 4, palette }, { zlib: { level: 9 } });
    return compact.length < encoded.length ? compact : encoded;
  }

  function pageRange(value, count) {
    if (!Number.isInteger(count) || count < 1) throw new Error('Quantidade de páginas inválida.');
    if (!value.trim()) return [];
    const result = [];
    const seen = new Set();
    for (const part of value.split(',')) {
      const match = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/u.exec(part);
      if (!match) throw new Error('Use páginas como 1-5, 8, 12-15.');
      const first = Number(match[1]);
      const last = Number(match[2] ?? match[1]);
      if (first < 1 || last < first || last > count) throw new Error(`Escolha páginas entre 1 e ${count}, com intervalos crescentes.`);
      for (let page = first; page <= last; page++) {
        if (seen.has(page)) continue;
        seen.add(page);
        result.push(page);
      }
    }
    return result;
  }

  function uniqueName(name, used) {
    let candidate = name;
    for (let suffix = 2; used.has(candidate.toLowerCase()); suffix++) {
      const ending = `_${suffix}`;
      candidate = name.slice(0, 32 - ending.length) + ending;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  }

  function pageRangeText(numbers) {
    const parts = [];
    for (const number of numbers) {
      const last = parts.at(-1);
      if (last && number === last[1] + 1) last[1] = number;
      else parts.push([number, number]);
    }
    return parts.map(([first, last]) => first === last ? String(first) : `${first}-${last}`).join(', ');
  }

  function groups(documents, pages, mode, name) {
    if (!['separate', 'combined'].includes(mode)) throw new Error('Modo de organização inválido.');
    const result = mode === 'combined'
      ? (pages.length ? [{ name, pages }] : [])
      : documents.map(document => ({ name: document.name, pages: pages.filter(page => page.documentId === document.id) }))
        .filter(group => group.pages.length);
    const used = new Set();
    for (const group of result) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(group.name)) throw new Error('Nome do app: 1 a 32 letras ASCII, números ou _, começando com letra.');
      if (used.has(group.name.toLowerCase())) throw new Error(`Nome de app repetido: ${group.name}. Renomeie antes de preparar.`);
      used.add(group.name.toLowerCase());
    }
    return result;
  }

  function prepareApp(template, pages) {
    if (!pages.length) throw new Error('Selecione pelo menos uma imagem ou PDF.');
    const digits = Math.max(3, String(pages.length).length);
    return {
      descriptor: template.descriptor, source: template.source, note: new Uint8Array(),
      resources: [
        ...pages.map((page, index) => ({
          name: `${String(index + 1).padStart(digits, '0')}.png`, content: page.content,
        })),
        { name: 'icon.png', content: template.icon },
      ],
    };
  }

  function archive(apps, template) {
    if (!apps.length) throw new Error('Nenhum app para baixar.');
    if (!template.program?.length) throw new Error('Modelo de programa ausente para download.');
    const files = {};
    const used = new Set();
    for (const app of apps) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/u.test(app.name) || used.has(app.name.toLowerCase())) {
        throw new Error('Nome inválido ou repetido no download.');
      }
      used.add(app.name.toLowerCase());
      const prefix = `${app.name}.hpappdir/`;
      files[`${prefix}${app.name}.hpapp`] = app.descriptor;
      files[`${prefix}${app.name}.hpappprgm`] = template.program;
      for (const resource of app.resources) {
        if (!/^(?:\d+|icon)\.png$/u.test(resource.name)) throw new Error('Recurso inválido no download.');
        files[prefix + resource.name] = resource.content;
      }
    }
    return png.zipSync(files, { level: 0 });
  }

  return { appName, encode, prepareApp, pageRange, pageRangeText, uniqueName, groups, archive };
});
