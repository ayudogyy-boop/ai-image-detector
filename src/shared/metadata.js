/*
 * 文件元数据与来源自述解析。零第三方依赖，不调用 chrome API。
 * 由 offscreen 和 Node/Chrome 测试复用；未验签自述不证明图片真实性。
 * 完整 C2PA 验签在 offscreen/verify-c2pa.js，最终判定在 shared/scoring.js。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.AIDMetadata = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ── 容器嗅探（不依赖 URL 扩展名）─────────────────────────────
  const CONTAINERS = [
    { name: 'jpeg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
    { name: 'png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
    { name: 'gif', mime: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
    { name: 'webp', mime: 'image/webp', magic: [0x52, 0x49, 0x46, 0x46], extra: { at: 8, magic: [0x57, 0x45, 0x42, 0x50] } },
    { name: 'avif', mime: 'image/avif', magic: null, ftyp: ['avif', 'avis'] },
    { name: 'heic', mime: 'image/heic', magic: null, ftyp: ['heic', 'heix', 'hevc', 'mif1'] },
    { name: 'bmp', mime: 'image/bmp', magic: [0x42, 0x4d] },
    { name: 'tiff', mime: 'image/tiff', magic: [0x49, 0x49, 0x2a, 0x00] },
    { name: 'tiff', mime: 'image/tiff', magic: [0x4d, 0x4d, 0x00, 0x2a] },
  ];

  function startsWith(bytes, magic, at) {
    at = at || 0;
    if (bytes.length < at + magic.length) return false;
    for (let i = 0; i < magic.length; i++) if (bytes[at + i] !== magic[i]) return false;
    return true;
  }

  function sniffContainer(bytes) {
    if (!bytes || bytes.length < 12) return { container: 'unknown', mime: null };
    for (const c of CONTAINERS) {
      if (c.ftyp) {
        if (startsWith(bytes, [0x00, 0x00, 0x00]) && String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp') {
          const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
          if (c.ftyp.includes(brand)) return { container: c.name, mime: c.mime };
        }
        continue;
      }
      if (!c.magic) continue;
      if (!startsWith(bytes, c.magic)) continue;
      if (c.extra && !startsWith(bytes, c.extra.magic, c.extra.at)) continue;
      return { container: c.name, mime: c.mime };
    }
    return { container: 'unknown', mime: null };
  }

  // ── 工具 ─────────────────────────────────────────────────────
  function ascii(bytes, start, len) {
    let s = '';
    for (let i = 0; i < len && start + i < bytes.length; i++) s += String.fromCharCode(bytes[start + i]);
    return s;
  }

  function latin1(bytes, start, end) {
    let s = '';
    for (let i = start; i < end && i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  function utf8(bytes, start, end) {
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(start, Math.min(end, bytes.length)));
    } catch (_) {
      return latin1(bytes, start, end);
    }
  }

  /** 在字节流里找 ASCII 串（现有 C2PA 扫描用的就是这招） */
  function findStrings(bytes, minLen) {
    minLen = minLen || 4;
    const out = [];
    let cur = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (b >= 0x20 && b <= 0x7e) cur += String.fromCharCode(b);
      else { if (cur.length >= minLen) out.push(cur); cur = ''; }
    }
    if (cur.length >= minLen) out.push(cur);
    return out;
  }

  function hasJumb(bytes) {
    for (let i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] === 0x6a && bytes[i + 1] === 0x75 && bytes[i + 2] === 0x6d && bytes[i + 3] === 0x62) return true;
    }
    return false;
  }

  // ── C2PA / JUMBF 旧关键词线索（仅用于显示，不进入判定）──
  const C2PA_SOFTWARE_AI = [
    'openai', 'dall-e', 'gpt-image', 'adobe firefly', 'midjourney',
    'stability ai', 'stable diffusion', 'runway', 'pika', 'sora',
    'comfyui', 'automatic1111', 'sd-webui', 'fooocus', 'invokeai',
    'flux', 'black forest labs', 'krea', 'leonardo.ai', 'ideogram',
    'recraft', 'imagen', 'seedream', 'jimeng', '即梦', 'niji',
  ];
  const C2PA_SOFTWARE_CAMERA = [
    'nikon', 'canon', 'sony', 'leica', 'fujifilm', 'panasonic',
    'olympus', 'pentax', 'phase one', 'hasselblad', 'google pixel',
    'truepic',
  ];

  function parseC2PASignals(strings) {
    let generator = null;
    let timestamp = null;
    for (const s of strings) {
      const lower = s.toLowerCase();
      if (C2PA_SOFTWARE_AI.some((kw) => lower.includes(kw)) || C2PA_SOFTWARE_CAMERA.some((kw) => lower.includes(kw))) {
        generator = s;
        break;
      }
    }
    if (!generator) {
      for (let i = 0; i < strings.length; i++) {
        if (/softwareagent|generator|creatortool|Copyrigh/i.test(strings[i])) {
          for (let j = i + 1; j < Math.min(i + 5, strings.length); j++) {
            if (strings[j].length >= 3 && /[A-Za-z]/.test(strings[j]) && !/^[\s\d]+$/.test(strings[j])) { generator = strings[j]; break; }
          }
          if (generator) break;
        }
      }
    }
    const gLow = generator ? generator.toLowerCase() : '';
    let isAI = null;
    if (generator) {
      if (C2PA_SOFTWARE_AI.some((kw) => gLow.includes(kw))) isAI = true;
      else if (C2PA_SOFTWARE_CAMERA.some((kw) => gLow.includes(kw))) isAI = false;
    }
    for (let i = 0; i < strings.length; i++) {
      if (/^(dc:created|dc:modified)$/.test(strings[i]) && i + 1 < strings.length && /\d{4}/.test(strings[i + 1])) { timestamp = strings[i + 1]; break; }
      const iso = strings[i].match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:[+-]\d{2}:\d{2}|Z)).*/);
      if (iso) { timestamp = iso[1]; break; }
    }
    return { hasC2PA: true, isAI, generator, timestamp, strings };
  }

  /** 旧容器线索扫描，不是签名验证；最终以完整 SDK 结果为准。 */
  function readC2PA(bytes, extraStrings) {
    // 仅保留有界展示线索；真正验签仍交给 SDK 处理整份资产。
    bytes = bytes.subarray(0, 512 * 1024);
    const strings = extraStrings && extraStrings.length ? extraStrings.slice() : [];
    if (strings.length === 0) {
      if (!hasJumb(bytes)) return { hasC2PA: false, isAI: null, generator: null, timestamp: null };
      for (const value of findStrings(bytes, 4)) strings.push(value);
    }
    const uniq = [...new Set(strings)];
    if (uniq.length === 0) return { hasC2PA: false, isAI: null, generator: null, timestamp: null };
    return parseC2PASignals(uniq);
  }

  // ── PNG：tEXt / iTXt / zTXt + IHDR ──────────────────────────
  // 这是本项目原先完全漏掉、而价值最高的一块：
  //   Stable Diffusion WebUI 写 tEXt["parameters"]（整段提示词+参数）
  //   ComfyUI                 写 tEXt["prompt"] / tEXt["workflow"]（JSON）
  //   各类工具常写 tEXt["Software"] / iTXt["XML:com.adobe.xmp"]

  function parsePNG(bytes) {
    const out = { width: null, height: null, text: {}, textKeys: [], compressedKeys: [], compressedText: [], xmp: null, exifOffset: null };
    if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return out;
    let off = 8;
    let guard = 0;
    while (off + 8 <= bytes.length && guard++ < 4096) {
      const len = (bytes[off] << 24 | bytes[off + 1] << 16 | bytes[off + 2] << 8 | bytes[off + 3]) >>> 0;
      const type = ascii(bytes, off + 4, 4);
      const dataStart = off + 8;
      const dataEnd = dataStart + len;
      if (dataEnd > bytes.length) break;
      if (len > 64 * 1024 * 1024) break;
      if (len > 1024 * 1024 && ['tEXt', 'iTXt', 'zTXt'].includes(type)) { off = dataEnd + 4; continue; }

      if (type === 'IHDR' && len >= 8) {
        out.width = (bytes[dataStart] << 24 | bytes[dataStart + 1] << 16 | bytes[dataStart + 2] << 8 | bytes[dataStart + 3]) >>> 0;
        out.height = (bytes[dataStart + 4] << 24 | bytes[dataStart + 5] << 16 | bytes[dataStart + 6] << 8 | bytes[dataStart + 7]) >>> 0;
      } else if (type === 'tEXt') {
        const sep = bytes.indexOf(0x00, dataStart);
        if (sep > -1 && sep < dataEnd) {
          const key = latin1(bytes, dataStart, sep);
          out.text[key] = latin1(bytes, sep + 1, dataEnd);
          out.textKeys.push(key);
        }
      } else if (type === 'iTXt') {
        const sep = bytes.indexOf(0x00, dataStart);
        if (sep > -1 && sep < dataEnd) {
          const key = latin1(bytes, dataStart, sep);
          const compFlag = bytes[sep + 1];
          out.textKeys.push(key);
          if (compFlag === 1) {
            out.compressedKeys.push(key);
            const langEnd = bytes.indexOf(0, sep + 3);
            const transEnd = langEnd >= 0 && langEnd < dataEnd ? bytes.indexOf(0, langEnd + 1) : -1;
            if (bytes[sep + 2] === 0 && transEnd >= 0 && transEnd < dataEnd) out.compressedText.push({ key, encoding: 'utf-8', data: bytes.subarray(transEnd + 1, dataEnd) });
          } else {
            // keyword \0 compFlag compMethod langTag \0 translatedKeyword \0 text
            let p = sep + 3;
            const langEnd = bytes.indexOf(0x00, p);
            const transEnd = langEnd > -1 && langEnd < dataEnd ? bytes.indexOf(0x00, langEnd + 1) : -1;
            if (p <= dataEnd && transEnd > -1 && transEnd < dataEnd) {
              out.text[key] = utf8(bytes, transEnd + 1, dataEnd);
            }
          }
        }
      } else if (type === 'zTXt') {
        const sep = bytes.indexOf(0x00, dataStart);
        if (sep > -1 && sep + 2 <= dataEnd && bytes[sep + 1] === 0) {
          const key = latin1(bytes, dataStart, sep);
          out.compressedKeys.push(key);
          out.compressedText.push({ key, encoding: 'latin1', data: bytes.subarray(sep + 2, dataEnd) });
        }
      } else if (type === 'eXIf') {
        out.exifOffset = dataStart;
        out.exifLength = len;
      } else if (type === 'IEND') {
        break;
      }
      off = dataEnd + 4; // 跳过 CRC
    }
    if (out.text['XML:com.adobe.xmp']) out.xmp = out.text['XML:com.adobe.xmp'];
    return out;
  }

  // ── JPEG：APP1(EXIF) / APP1(XMP) / APP11(JUMBF/C2PA) / SOF ──
  const JPEG_SEGMENT_NAMES = {
    0xe0: 'APP0', 0xe1: 'APP1', 0xe2: 'APP2', 0xe3: 'APP3', 0xe4: 'APP4', 0xe5: 'APP5',
    0xe6: 'APP6', 0xe7: 'APP7', 0xe8: 'APP8', 0xe9: 'APP9', 0xea: 'APP10', 0xeb: 'APP11',
    0xec: 'APP12', 0xed: 'APP13', 0xee: 'APP14', 0xef: 'APP15',
    0xdb: 'DQT', 0xc4: 'DHT', 0xc0: 'SOF0', 0xc1: 'SOF1', 0xc2: 'SOF2', 0xc3: 'SOF3',
    0xfe: 'COM', 0xdd: 'DRI',
  };

  function parseJPEG(bytes) {
    const out = { width: null, height: null, exif: null, xmp: null, c2pa: { present: false, strings: [] }, c2paStrings: [], compressedKeys: [], segments: [] };
    if (!startsWith(bytes, [0xff, 0xd8, 0xff])) return out;
    let off = 2;
    let guard = 0;
    while (off + 4 <= bytes.length && guard++ < 4096) {
      if (bytes[off] !== 0xff) { off++; continue; }
      const marker = bytes[off + 1];
      if (marker === 0xd9) break;                                  // EOI
      if (marker === 0xda) { out.segments.push({ marker: 'SOS', offset: off, length: 0 }); break; } // SOS，后面是压缩数据
      if (marker >= 0xd0 && marker <= 0xd7) { off += 2; continue; } // RSTn
      if (marker === 0x00 || marker === 0xff) { off++; continue; }
      const segLen = (bytes[off + 2] << 8) | bytes[off + 3];
      if (segLen < 2) break;
      const dataStart = off + 4;
      const dataEnd = off + 2 + segLen;

      out.segments.push({ marker: JPEG_SEGMENT_NAMES[marker] || '0x' + marker.toString(16), offset: off, length: segLen });

      // SOF0..SOF15 → 尺寸（C4/C8/CC 不是 SOF）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (dataStart + 5 <= bytes.length) {
          out.height = (bytes[dataStart + 1] << 8) | bytes[dataStart + 2];
          out.width = (bytes[dataStart + 3] << 8) | bytes[dataStart + 4];
        }
      } else if (marker === 0xe1 && dataEnd <= bytes.length) {
        const head = ascii(bytes, dataStart, 6);
        if (head === 'Exif\0\0') {
          out.exif = parseExifTIFF(bytes, dataStart + 6, dataEnd);
        } else if (ascii(bytes, dataStart, 28) === 'http://ns.adobe.com/xap/1.0/') {
          out.xmp = utf8(bytes, dataStart + 29, dataEnd);
        }
      } else if (marker === 0xeb) {
        if (dataEnd <= bytes.length) out.aigc = parseAIGC(utf8(bytes, dataStart, dataEnd)) || out.aigc;
        const seg = bytes.subarray(dataStart, dataEnd);
        if (hasJumb(seg)) {
          out.c2pa.present = true;
          out.c2paStrings.push(...findStrings(seg, 4));
        }
      } else if (marker === 0xfe) {
        out.comment = latin1(bytes, dataStart, dataEnd);
      }

      if (dataEnd > bytes.length) break;
      off = dataEnd;
    }
    // JUMBF/C2PA 可能不在 JPEG 段结构里（或我们只拿到了文件头部），做一次兜底原始扫描
    if (!out.c2pa.present && hasJumb(bytes)) {
      out.c2pa.present = true;
      out.c2paStrings.push(...findStrings(bytes, 4));
    }
    return out;
  }

  // ── EXIF (TIFF 结构，JPEG 与 PNG eXIf 共用) ──────────────────
  const EXIF_TAGS = {
    0x010e: 'imageDescription', 0x010f: 'make', 0x0110: 'model', 0x0112: 'orientation',
    0x0131: 'software', 0x0132: 'dateTime', 0x8298: 'copyright',
    0x9003: 'dateTimeOriginal', 0x9004: 'dateTimeDigitized', 0xa430: 'cameraOwnerName',
    0xa431: 'serialNumber', 0x8769: 'exifIFDPointer', 0x8825: 'gpsIFDPointer',
  };
  const GPS_TAGS_PRESENT = { 0x0001: 'gpsLatitudeRef', 0x0002: 'gpsLatitude', 0x0003: 'gpsLongitudeRef', 0x0004: 'gpsLongitude' };

  function parseExifTIFF(bytes, base, limit) {
    const out = {};
    try {
      limit = Math.min(limit == null ? bytes.length : limit, bytes.length);
      const inBounds = (offset, size) => Number.isInteger(offset) && offset >= base && offset + size <= limit;
      if (!inBounds(base, 8)) return null;
      const endian = String.fromCharCode(bytes[base], bytes[base + 1]);
      const le = endian === 'II';
      if (!le && endian !== 'MM') return null;
      const r16 = (o) => (le ? bytes[o] | (bytes[o + 1] << 8) : (bytes[o] << 8) | bytes[o + 1]);
      const r32 = (o) => (le
        ? (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) >>> 0
        : ((bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3]) >>> 0);
      if (r16(base + 2) !== 42) return null;

      function readIFD(ifdOffset, depth) {
        if (depth > 3 || ifdOffset < 8 || !inBounds(base + ifdOffset, 2)) return;
        const n = r16(base + ifdOffset);
        if (n > 200) return;
        for (let i = 0; i < n; i++) {
          const eo = base + ifdOffset + 2 + i * 12;
          if (!inBounds(eo, 12)) return;
          const tag = r16(eo);
          const type = r16(eo + 2);
          const count = r32(eo + 4);
          const valueOffset = r32(eo + 8);
          const typeSize = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }[type] || 1;
          const totalSize = typeSize * count;
          const inline = totalSize <= 4;
          const dataOffset = inline ? eo + 8 : base + valueOffset;
          if (!inBounds(dataOffset, totalSize)) continue;

          if (type === 2 && count > 0 && count <= 4096) { // ASCII
            let s = '';
            for (let j = 0; j < count; j++) {
              const c = bytes[dataOffset + j];
              if (c === 0 || c === undefined) break;
              s += String.fromCharCode(c);
            }
            const name = EXIF_TAGS[tag];
            if (name && s) out[name] = s;
          } else if (tag === 0x8769 && type === 4 && count === 1 && depth < 3) {
            readIFD(valueOffset, depth + 1); // Exif 子 IFD
          } else if (tag === 0x8825 && type === 4 && count === 1 && valueOffset >= 8 && inBounds(base + valueOffset, 2)) {
            out.hasGps = true;
            const gn = r16(base + valueOffset);
            for (let k = 0; k < Math.min(gn, 64); k++) {
              const go = base + valueOffset + 2 + k * 12;
              if (!inBounds(go, 12)) break;
              const gtag = r16(go);
              const gname = GPS_TAGS_PRESENT[gtag];
              if (gname) out[gname] = true;
            }
          }
        }
      }
      readIFD(r32(base + 4), 0);
      return Object.keys(out).length ? out : null;
    } catch (_) {
      return null;
    }
  }

  // ── XMP 关键字段 ────────────────────────────────────────────
  function parseXMP(xml) {
    if (!xml) return null;
    const pick = (re) => { const m = xml.match(re); return m ? m[1].trim() : null; };
    const out = {
      creatorTool: pick(/<xmp:CreatorTool>([^<]*)<\/xmp:CreatorTool>/i)
        || pick(/xmp:CreatorTool=["']([^"']*)["']/i),
      make: pick(/<tiff:Make>([^<]*)<\/tiff:Make>/i) || pick(/tiff:Make=["']([^"']*)["']/i),
      model: pick(/<tiff:Model>([^<]*)<\/tiff:Model>/i) || pick(/tiff:Model=["']([^"']*)["']/i),
      createDate: pick(/<xmp:CreateDate>([^<]*)<\/xmp:CreateDate>/i),
      // IPTC DigitalSourceType —— 行业标准自述字段（Adobe Firefly、部分相机/平台会写）。
      // 三种常见写法：rdf:resource 属性 / 元素文本 / 普通属性。
      digitalSourceType: pick(/<Iptc4xmpExt:DigitalSourceType[^>]*rdf:resource=["']([^"']+)["']/i)
        || pick(/<Iptc4xmpExt:DigitalSourceType>([^<]*)<\/Iptc4xmpExt:DigitalSourceType>/i)
        || pick(/Iptc4xmpExt:DigitalSourceType=["']([^"']+)["']/i),
      aigc: pick(/<(?:[\w-]+:)?AIGC[^>]*>([^<]*)<\/(?:[\w-]+:)?AIGC>/i)?.replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
      history: (xml.match(/<stEvt:softwareAgent>([^<]*)<\/stEvt:softwareAgent>/gi) || []).map((s) => s.replace(/<[^>]+>/g, '').trim()).slice(0, 8),
    };
    const hasAny = Object.keys(out).some((k) => Array.isArray(out[k]) ? out[k].length : out[k]);
    return hasAny ? out : null;
  }

  // ── 统一入口 ─────────────────────────────────────────────────
  /**
   * 从图片文件头提取可用元数据；默认窗口 512KB，窗口之外的块无法解析。
   */
  function extractMetadata(bytes) {
    const { container, mime } = sniffContainer(bytes);
    const meta = {
      container, mime,
      width: null, height: null,
      exif: null, xmp: null,
      pngText: null, pngTextKeys: [], compressedKeys: [], aigc: null,
      c2pa: { hasC2PA: false, isAI: null, generator: null, timestamp: null },
      bytesInspected: bytes ? bytes.length : 0,
    };

    if (container === 'png') {
      const png = parsePNG(bytes);
      meta.width = png.width;
      meta.height = png.height;
      meta.pngText = Object.keys(png.text).length ? png.text : null;
      meta.pngTextKeys = png.textKeys;
      meta.compressedKeys = png.compressedKeys;
      meta.compressedText = png.compressedText;
      if (png.xmp) meta.xmp = parseXMP(png.xmp);
      if (png.exifOffset != null) meta.exif = parseExifTIFF(bytes, png.exifOffset, png.exifOffset + (png.exifLength || 0));
      meta.c2pa = readC2PA(bytes);
    } else if (container === 'jpeg') {
      const jpg = parseJPEG(bytes);
      meta.width = jpg.width;
      meta.height = jpg.height;
      meta.exif = jpg.exif;
      meta.xmp = parseXMP(jpg.xmp);
      meta.c2pa = readC2PA(bytes, jpg.c2paStrings);
      meta.segments = jpg.segments;
      if (jpg.comment) meta.comment = jpg.comment;
      if (jpg.aigc) meta.aigc = jpg.aigc;
    } else if (container === 'webp') {
      // WebP: RIFF....WEBP + chunks；EXIF/XMP 是独立 chunk
      let off = 12;
      while (off + 8 <= bytes.length) {
        const type = ascii(bytes, off, 4);
        const size = (bytes[off + 4] | (bytes[off + 5] << 8) | (bytes[off + 6] << 16) | (bytes[off + 7] << 24)) >>> 0;
        const ds = off + 8;
        if (ds + size > bytes.length) break;
        if (type === 'EXIF') meta.exif = parseExifTIFF(bytes, startsWith(bytes, [69, 120, 105, 102, 0, 0], ds) ? ds + 6 : ds, ds + size);
        else if (type === 'XMP ') meta.xmp = parseXMP(utf8(bytes, ds, ds + size));
        else if (type === 'VP8X' && size >= 10) {
          meta.width = 1 + (bytes[ds + 4] | (bytes[ds + 5] << 8) | (bytes[ds + 6] << 16));
          meta.height = 1 + (bytes[ds + 7] | (bytes[ds + 8] << 8) | (bytes[ds + 9] << 16));
        }
        if (size > bytes.length) break;
        off = ds + size + (size % 2);
      }
      meta.c2pa = readC2PA(bytes);
    }

    if (!meta.aigc) {
      const values = [meta.pngText?.AIGC, meta.pngText?.aigc, meta.comment, meta.exif?.imageDescription, meta.exif?.userComment, meta.xmp?.aigc];
      for (const value of values) { const label = parseAIGC(value); if (label) { meta.aigc = label; break; } }
    }
    if (!meta.xmp) meta.xmp = null;
    return meta;
  }

  // ── 事实 → 可读摘要（不含打分策略）────────────────────────────
  /** 把所有「软件来源」字符串归拢成一个数组，供上层判断 */
  function collectSoftwareStrings(meta) {
    const out = [];
    if (meta.exif) {
      for (const k of ['software', 'make', 'model', 'imageDescription', 'cameraOwnerName']) {
        if (meta.exif[k]) out.push({ source: 'exif.' + k, value: meta.exif[k] });
      }
    }
    if (meta.xmp) {
      for (const k of ['creatorTool', 'make', 'model', 'digitalSourceType']) {
        if (meta.xmp[k]) out.push({ source: 'xmp.' + k, value: meta.xmp[k] });
      }
      for (const h of meta.xmp.history || []) out.push({ source: 'xmp.history', value: h });
    }
    if (meta.pngText) {
      for (const [k, v] of Object.entries(meta.pngText)) {
        // 只带出短值，避免把整段 SD 提示词塞进摘要（长值由上层按需读）
        out.push({ source: 'png.' + k, value: v.length > 200 ? v.slice(0, 200) + '…' : v, fullLength: v.length });
      }
    }
    if (meta.comment) out.push({ source: 'jpeg.comment', value: meta.comment });
    return out;
  }

  // ── 判定：只认高精度确定性证据 ────────────────────────────────
  //
  // 关键词分两档 —— 这是 2026-10 审查的直接产物。
  // 审查实测：旧版把 `imagen` `flux` `krea` `niji` 这类短词拿去匹配 PNG 的 comment/description，
  // 于是 "imagen del paisaje al atardecer"（西班牙语：黄昏的风景照）被判成 AI；
  // "flux capacitör"（英文：通量电容器）也被判成 AI。短词在自由文本里必然误报。
  //
  //   AI_TOOL_STRICT_RE：多词或带型号的**生成器专名**，仅用于组成工具名匹配，不将自由文本提及当作生成证据
  //   AI_TOOL_FIELD_RE ：在 STRICT 基础上放宽到单个品牌词，**只允许**用在
  //                      software / generator / model 这类「本来就是工具名」的字段上
  const AI_TOOL_STRICT_RE = new RegExp(
    'midjourney|dall[\\s·\\-–]e|stable[\\s-]?diffusion|stability[\\s._-]?ai|adobe\\s+firefly'
    + '|gpt[\\s-]?image|openai|black\\s+forest\\s+labs|flux\\.1|flux[\\s-]?(?:pro|dev|schnell|kontext)'
    + '|comfyui|automatic1111|sd[\\s-]?webui|fooocus|invokeai|novelai|ideogram|recraft|seedream|jimeng|即梦'
    + '|leonardo\\.?ai|krea[\\s.]?ai|pika[\\s.]?art|runway[\\s-]?(?:ml|gen)|google\\s+imagen|imagen[\\s-]?[2-9]'
    + '|nano[\\s-]?banana|muse[\\s-]?image|meta[\\s.-]?ai|qwen[\\s-]?image|通义万相|\\bwanx\\b',
    'i'
  );
  const AI_TOOL_FIELD_RE = new RegExp(
    AI_TOOL_STRICT_RE.source + '|\\bflux\\b|\\bkrea\\b|\\bniji\\b|\\bimagen\\b|\\bsora\\b|\\bpika\\b|\\brunway\\b|\\bdiffusers\\b',
    'i'
  );
  const CAMERA_MAKE_RE = /nikon|canon|sony|leica|fujifilm|panasonic|olympus|om digital|pentax|phase one|hasselblad|apple|samsung|google|xiaomi|huawei|oppo|vivo|oneplus|motorola|ricoh|sigma|dji|gopro|insta360|truepic/i;

  /** 理由字符串里不要把整段 JSON 塞进 UI */
  function clipReason(s, n) {
    if (s === null || s === undefined) return '';
    const t = String(s).replace(/\s+/g, ' ').trim();
    const limit = n || 60;
    return t.length > limit ? t.slice(0, limit) + '…' : t;
  }

  /**
   * 相机 Make + Model 同时存在（且 Make 命中相机厂牌）。
   *
   * 注意：这**不再单独下结论**。审查实测表明 EXIF 完全由发布方控制（一行命令即可伪造），
   * 而且 AI 二次编辑（换脸、生成式填充）常常保留原相机 EXIF —— 旧版给这种情况发
   * 「可信 90」，属于典型的虚假安全感。现在它只是一个由 scoring 加权的信号。
   */
  function hasCameraEvidence(meta) {
    if (!meta) return false;
    const make = (meta.exif && meta.exif.make) || (meta.xmp && meta.xmp.make) || '';
    const model = (meta.exif && meta.exif.model) || (meta.xmp && meta.xmp.model) || '';
    return !!(CAMERA_MAKE_RE.test(make) && model);
  }

  function hasAiSoftwareEvidence(meta) {
    if (!meta) return false;
    if (meta.exif) for (const k of ['software']) if (meta.exif[k] && AI_TOOL_FIELD_RE.test(meta.exif[k])) return true;
    if (meta.xmp) for (const k of ['creatorTool']) if (meta.xmp[k] && AI_TOOL_FIELD_RE.test(meta.xmp[k])) return true;
    for (const [key, value] of Object.entries(meta.pngText || {})) if (/^(software|generator|model)$/i.test(key) && typeof value === 'string' && AI_TOOL_FIELD_RE.test(value)) return true;
    return false;
  }

  function isSDParameters(text) {
    return typeof text === 'string' && /Steps:\s*\d+/.test(text) && /Sampler:\s*[^,\n]+/.test(text)
      && /(?:CFG scale:\s*[\d.]+|Seed:\s*\d+|Model hash:\s*[0-9a-f]{6,})/i.test(text);
  }

  function isComfyGraph(text, workflow) {
    if (typeof text !== 'string' || text.length > 1024 * 1024) return false;
    try {
      const graph = JSON.parse(text);
      if (!graph || typeof graph !== 'object') return false;
      const nodes = workflow ? graph.nodes : Object.values(graph);
      return Array.isArray(nodes) && nodes.some((node) => node && typeof node === 'object'
        && /^(KSampler(?:Advanced)?|SamplerCustom(?:Advanced)?)$/.test(workflow ? node.type : node.class_type)
        && (workflow || (node.inputs && typeof node.inputs === 'object')));
    } catch (_) { return false; }
  }

  // 国内 AIGC 元数据只接受显式对象或 AIGC:JSON；不能把描述里随便出现的字母当作声明。
  function parseAIGC(text) {
    if (typeof text !== 'string' || text.length > 65536) return null;
    try {
      const value = JSON.parse(text.replace(/^AIGC[:\0]\s*/i, '').trim());
      const obj = value && (value.AIGC || value);
      const label = String(obj?.Label ?? obj?.label ?? '');
      const producer = obj?.ContentProducer ?? obj?.content_producer;
      if (!['1', '2', '3'].includes(label) || typeof producer !== 'string' || !producer.trim()) return null;
      return { label, producer: producer.slice(0, 120) };
    } catch (_) { return null; }
  }

  /** 返回文件自述，不表示已验签。相机自述与自由文本不直接判定。 */
  function judgeMetadata(meta, signals) {
    if (!meta) return null;
    signals = signals || {};
    const reasons = [];
    const dst = signals.c2pa !== false && meta.xmp && meta.xmp.digitalSourceType;
    if (typeof dst === 'string' && /^https?:\/\/cv\.iptc\.org\/newscodes\/digitalsourcetype\/(trainedAlgorithmicMedia|compositeWithTrainedAlgorithmicMedia)$/.test(dst)) {
      reasons.push('IPTC:声明使用 AI');
    }
    if (signals.exif !== false) {
      const t = Object.create(null);
      for (const [key, value] of Object.entries(meta.pngText || {})) t[key.toLowerCase()] = value;
      if (isSDParameters(t.parameters)) reasons.push('PNG parameters(SD)');
      if (isComfyGraph(t.prompt, false)) reasons.push('PNG prompt(ComfyUI)');
      if (isComfyGraph(t.workflow, true)) reasons.push('PNG workflow(ComfyUI)');
      for (const key of ['software', 'generator', 'model']) {
        if (t[key] && AI_TOOL_FIELD_RE.test(t[key])) reasons.push('PNG ' + key + ':' + clipReason(t[key], 40));
      }
      if (isSDParameters(meta.comment)) reasons.push('JPEG comment:SD 生成参数');
      for (const [name, obj, keys] of [['exif', meta.exif, ['software']], ['xmp', meta.xmp, ['creatorTool']]]) {
        for (const key of keys) if (obj?.[key] && AI_TOOL_FIELD_RE.test(obj[key])) reasons.push(name + '.' + key + ':' + clipReason(obj[key], 40));
      }
      if (meta.aigc?.label === '1') reasons.push('AIGC:声明 AI 生成，来源 ' + clipReason(meta.aigc.producer));
    }
    return reasons.length ? { verdict: 'red', reasons, verified: false, evidenceLevel: 'declaration' } : null;
  }

  // ── 建议的文件头抓取字节数 ────────────────────────────────────
  // 为什么是 512KB 而不是 64KB：
  //   旧实现用 `Range: bytes=0-65535` 取 EXIF，但实测 test-c2pa/camera-nikon.jpg 的
  //   EXIF 段本身就长 65534 字节，**刚好占满整个窗口**；该文件的 C2PA(APP11) 占 65KB–304KB，
  //   XMP 段在 303942，SOF0(尺寸) 在 342384。也就是说：**恰恰在带相机签名、元数据最丰富的图上，
  //   旧实现几乎什么都看不到。**
  //   512KB 可覆盖该案例（到 SOS 为止），且仍是一次请求，比旧的「64KB + 3×256KB」更省。
  const RECOMMENDED_HEADER_BYTES = 512 * 1024;

  // 视觉模型需要整张图，但必须有上限：旧实现直接 resp.blob()，服务器给多大就吃多大。
  const ONNX_SOURCE_MAX_BYTES = 40 * 1024 * 1024;

  /**
   * 有上限地读一个 fetch 响应体。
   *
   * 存在的理由：Range 请求经常被服务器无视（直接回 200 + 整图），而 `arrayBuffer()`
   * 会把整个响应读进内存。实测本地静态服务器忽略 Range 时，一次"只读文件头"的请求
   * 实际读入了 1.53MB 的完整图片；换成一个 200MB 的资源就会直接撑爆内存。
   */
  async function readCapped(resp, maxBytes, requireComplete = false) {
    if (!resp.body || typeof resp.body.getReader !== 'function') {
      // 没有流（例如受测的 mock fetch / 老实现）：只能整块读，读完后按上限截断
      const u8 = new Uint8Array(await resp.arrayBuffer());
      if (requireComplete && u8.length > maxBytes) throw new Error('image-too-large');
      return u8.length > maxBytes ? u8.subarray(0, maxBytes) : u8;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const remain = maxBytes - total;
        if (value.byteLength > remain || (!requireComplete && value.byteLength === remain)) {
          chunks.push(remain > 0 ? value.subarray(0, remain) : value.subarray(0, 0));
          total = maxBytes;
          try { await reader.cancel(); } catch (_) {}
          if (requireComplete) throw new Error('image-too-large');
          break;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    } catch (err) {
      if (requireComplete) {
        try { await reader.cancel(); } catch (_) {}
        // 解压流失败前读出的字节也要计入文件总预算。
        const failure = new Error(err?.message || String(err));
        failure.bytesRead = total;
        throw failure;
      }
      // 读流中断（超时/网络抖动）：用已经拿到的部分继续，解析器本身是容错的
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      if (off >= out.length) break;
      const n = Math.min(c.byteLength, out.length - off);
      out.set(c.subarray(0, n), off);
      off += n;
    }
    return off === out.length ? out : out.subarray(0, off);
  }

  /**
   * 抓取字节（可选 Range），并强制上限。
   * @returns {Promise<Uint8Array|null>} 失败一律返回 null，不抛异常
   */
  async function fetchBytesCapped(url, maxBytes, timeoutMs, fetchImpl, options) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    const fail = (code, status) => {
      if (options?.onError) options.onError({ code, ...(status ? { status } : {}) });
      return null;
    };
    if (!doFetch) return fail('image-fetch-failed');
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const tid = ac ? setTimeout(() => ac.abort(), timeoutMs) : null;
    let reading = false;
    try {
      const useRange = !options || options.range !== false;
      const r = await doFetch(url, {
        headers: useRange ? { Range: 'bytes=0-' + (maxBytes - 1) } : undefined,
        signal: ac ? ac.signal : undefined,
      });
      if (!r || !r.ok) return fail('image-http-error', r?.status);
      reading = true;
      const complete = options && options.range === false;
      const length = Number(r.headers?.get('Content-Length'));
      if (complete && length > maxBytes) { await r.body?.cancel(); return fail('image-too-large'); }
      const bytes = await readCapped(r, maxBytes, complete);
      return bytes && bytes.length ? bytes : fail('image-empty');
    } catch (err) {
      return fail(ac?.signal.aborted ? 'image-fetch-timeout' : err?.message === 'image-too-large'
        ? 'image-too-large' : reading ? 'image-read-failed' : 'image-fetch-failed');
    } finally {
      if (tid) clearTimeout(tid);
    }
  }

  /** 只要文件头（Range 请求 + 512KB 上限） */
  function fetchHeaderBytes(url, maxBytes, timeoutMs, fetchImpl) {
    return fetchBytesCapped(url, maxBytes || RECOMMENDED_HEADER_BYTES, timeoutMs, fetchImpl, { range: true });
  }

  // ── 完整流水线：抓字节 → 解析 → 判定 ──────────────────────────
  // 放在共享模块里（而不是散在 Service Worker 里）的原因是：这样它就是**可测的生产代码**，
  // Node 单测与浏览器里调用的是同一个函数，而不是各自复刻一遍。

  /**
   * 把「已经拿到的字节」变成可以回传的事实对象。
   *
   * 抽出来的原因：offscreen 文档为了跑推理本来就要下载整张图，它可以直接从同一份字节里
   * 取前 512KB 做元数据解析 —— 这样每张图只下载一次，而不是「SW 抓 512KB + offscreen 抓整图」两次。
   */
  function summarizeBytes(bytes, parsedMeta) {
    const clip = (s, n) => (typeof s === 'string' ? (s.length > n ? s.slice(0, n) : s) : null);
    const emptyC2pa = { hasC2PA: false, isAI: null, generator: null, timestamp: null };

    if (!bytes || bytes.length < 16) {
      return { ok: false, reason: 'no-bytes', c2pa: emptyC2pa, verdict: null, verdictReasons: [], cameraEvidence: false, aiSoftwareEvidence: false };
    }

    let meta = null;
    try { meta = parsedMeta || extractMetadata(bytes); } catch (_) {}

    let verdict = null;
    try { verdict = meta ? judgeMetadata(meta) : null; } catch (_) {}

    const c2pa = (meta && meta.c2pa) ? meta.c2pa : emptyC2pa;

    // 只回传「事实」，且截断长字符串——postMessage 不该搬大块数据
    const textOut = {};
    if (meta && meta.pngText) {
      for (const k of Object.keys(meta.pngText)) {
        if (/^(parameters|prompt|workflow|software|generator|model|comment|description)$/i.test(k)) {
          textOut[k] = clip(meta.pngText[k], 400);
        }
      }
    }

    return {
      ok: true,
      bytesInspected: bytes.length,
      container: meta ? meta.container : null,
      width: meta ? meta.width : null,
      height: meta ? meta.height : null,
      exif: meta && meta.exif ? {
        make: clip(meta.exif.make, 80),
        model: clip(meta.exif.model, 80),
        software: clip(meta.exif.software, 120),
        dateTimeOriginal: clip(meta.exif.dateTimeOriginal, 40),
        hasGps: !!meta.exif.hasGps,
      } : null,
      xmp: meta && meta.xmp ? {
        creatorTool: clip(meta.xmp.creatorTool, 120),
        make: clip(meta.xmp.make, 80),
        model: clip(meta.xmp.model, 80),
        digitalSourceType: clip(meta.xmp.digitalSourceType, 160),
      } : null,
      pngTextKeys: meta ? (meta.pngTextKeys || []).slice(0, 40) : [],
      pngText: textOut,
      compressedKeys: meta ? (meta.compressedKeys || []).slice(0, 40) : [],
      softwareStrings: meta ? collectSoftwareStrings(meta).slice(0, 24) : [],
      comment: meta ? clip(meta.comment, 200) : null,
      aigc: meta?.aigc || null,
      verdict: verdict ? verdict.verdict : null,
      verdictReasons: verdict ? verdict.reasons : [],
      // 保留各开关单独启用时的结论，避免先合并冲突后再过滤导致证据永久丢失。
      verdictBySignal: meta ? {
        c2pa: judgeMetadata(meta, { exif: false }, true),
        exif: judgeMetadata(meta, { c2pa: false }, true),
      } : {},
      // 相机 EXIF 不再单独下结论，改成交给 scoring 加权的信号
      cameraEvidence: meta ? hasCameraEvidence(meta) : false,
      aiSoftwareEvidence: meta ? hasAiSoftwareEvidence(meta) : false,
      // c2pa.strings 可能上千条（实测 1520 条 / 14.6KB），这是内部证据，不进消息体
      c2pa: {
        hasC2PA: !!c2pa.hasC2PA,
        isAI: c2pa.isAI === undefined ? null : c2pa.isAI,
        generator: clip(c2pa.generator, 120),
        timestamp: clip(c2pa.timestamp, 40),
      },
    };
  }

  /** 用平台原生 zlib 解压，整个文件最多解出 1MB 文本、最多 16 块。 */
  async function summarizeBytesAsync(bytes) {
    if (!bytes || bytes.length < 16) return summarizeBytes(bytes);
    const meta = extractMetadata(bytes);
    let budget = 1024 * 1024;
    if (typeof DecompressionStream !== 'undefined') {
      for (const entry of (meta.compressedText || []).slice(0, 16)) {
        if (budget <= 0) break;
        try {
          const stream = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate'));
          const inflated = await readCapped({ body: stream }, budget + 1, true);
          if (inflated.length > budget) { budget = 0; continue; }
          budget -= inflated.length;
          const text = entry.encoding === 'latin1' ? latin1(inflated, 0, inflated.length) : utf8(inflated, 0, inflated.length);
          if (!meta.pngText) meta.pngText = {};
          meta.pngText[entry.key] = text;
          if (entry.key === 'XML:com.adobe.xmp') meta.xmp = parseXMP(text);
          if (/^aigc$/i.test(entry.key)) meta.aigc = parseAIGC(text) || meta.aigc;
          meta.compressedKeys = meta.compressedKeys.filter((k) => k !== entry.key);
        } catch (err) {
          budget = Math.max(0, budget - (err.bytesRead || 0));
          // 损坏/不支持的压缩文本保留在 compressedKeys，不猜内容。
        }
      }
    }
    return summarizeBytes(bytes, meta);
  }

  /**
   * 抓取图片文件头、解析全部元数据、给出确定性判定。
   * @param {string} url
   * @param {{fetchImpl?:Function, timeoutMs?:number, maxBytes?:number}} [options]
   */
  async function analyzeUrl(url, options) {
    options = options || {};
    const maxBytes = options.maxBytes || RECOMMENDED_HEADER_BYTES;
    const timeoutMs = options.timeoutMs == null ? 6000 : options.timeoutMs;

    const bytes = await fetchHeaderBytes(url, maxBytes, timeoutMs, options.fetchImpl);
    if (!bytes) {
      return {
        ok: false, reason: 'no-bytes',
        c2pa: { hasC2PA: false, isAI: null, generator: null, timestamp: null },
        verdict: null, verdictReasons: [], cameraEvidence: false, aiSoftwareEvidence: false,
      };
    }
    return summarizeBytesAsync(bytes);
  }

  return {
    RECOMMENDED_HEADER_BYTES,
    ONNX_SOURCE_MAX_BYTES,
    sniffContainer,
    extractMetadata,
    judgeMetadata,
    parseAIGC,
    isSDParameters,
    isComfyGraph,
    hasCameraEvidence,
    hasAiSoftwareEvidence,
    summarizeBytes,
    summarizeBytesAsync,
    analyzeUrl,
    fetchHeaderBytes,
    fetchBytesCapped,
    readCapped,
    readC2PA,
    parseC2PASignals,
    parsePNG,
    parseJPEG,
    parseExifTIFF,
    parseXMP,
    collectSoftwareStrings,
    findStrings,
    hasJumb,
    _internal: { startsWith, ascii, latin1, utf8, AI_TOOL_STRICT_RE, AI_TOOL_FIELD_RE },
  };
});
