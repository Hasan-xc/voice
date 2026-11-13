// ---- pure helpers (browser + Node tests) --------------------------------
// Loaded before every other script. No DOM access here.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.keys(api).forEach(k => { root[k] = api[k]; });
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Split after a punctuation mark only when it is followed by whitespace/end.
  // This replaces regex lookbehind, which Safari < 16.4 does not support.
  function splitAfterPunct(text, re) {
    const s = String(text == null ? '' : text);
    const out = [];
    let start = 0;
    for (let i = 0; i < s.length; i++) {
      if (re.test(s[i]) && (i + 1 >= s.length || /\s/.test(s[i + 1]))) {
        const part = s.slice(start, i + 1).trim();
        if (part) out.push(part);
        start = i + 1;
      }
    }
    const tail = s.slice(start).trim();
    if (tail) out.push(tail);
    return out;
  }
  const SENT_PUNCT = /[.!?؟؛…。！？]/;
  const CLAUSE_PUNCT = /[,،:;]/;
  function splitSentences(text) {
    const out = [];
    for (const para of String(text == null ? '' : text).replace(/\r/g, '').split(/\n+/)) {
      const p = para.trim();
      if (!p) continue;
      out.push(...splitAfterPunct(p, SENT_PUNCT));
    }
    return out;
  }

  // ---- story title -> safe file name --------------------------------------
  // "### سر البيت القديم 🏚️" -> "سر البيت القديم". Used as the default name
  // for the merged file and the ZIP, so exports are named after the story
  // instead of the generic "merged".
  function storyTitle(text, maxWords = 5, maxLen = 48) {
    const src = String(text == null ? '' : text).replace(/\r/g, '\n');
    let line = '';
    for (const raw of src.split('\n')) {
      if (raw.trim()) { line = raw.trim(); break; }
    }
    if (!line) return '';
    const s = line
      .replace(/^[\s#>*_=~\-–—•·]+/, '')                 // leading markdown bullets
      .replace(/^[\d٠-٩]+[.)\-–—]\s*/, '')               // "1." / "١-" numbering
      .replace(/[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\uFE0F\u200D]/gu, ' ')
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')            // forbidden in file names
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return '';
    return s.split(' ').filter(Boolean).slice(0, Math.max(1, maxWords)).join(' ')
      .slice(0, maxLen).replace(/[.,;:!?،؛…#*_\s]+$/, '').trim();
  }

  // ---- Windows-1256 (Arabic ANSI) decoder ---------------------------------
  // TextDecoder does not support windows-1256 in Safari/Node, so the mapping is
  // embedded. Values are the official CP1256 code points for bytes 0x80..0xFF.
  const CP1256_HIGH = [
    0x20AC, 0x067E, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021,
    0x02C6, 0x2030, 0x0679, 0x2039, 0x0152, 0x0686, 0x0698, 0x0688,
    0x06AF, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x06A9, 0x2122, 0x0691, 0x203A, 0x0153, 0x200C, 0x200D, 0x06BA,
    0x00A0, 0x060C, 0x00A2, 0x00A3, 0x00A4, 0x00A5, 0x00A6, 0x00A7,
    0x00A8, 0x00A9, 0x06BE, 0x00AB, 0x00AC, 0x00AD, 0x00AE, 0x00AF,
    0x00B0, 0x00B1, 0x00B2, 0x00B3, 0x00B4, 0x00B5, 0x00B6, 0x00B7,
    0x00B8, 0x00B9, 0x061B, 0x00BB, 0x00BC, 0x00BD, 0x00BE, 0x061F,
    0x06C1, 0x0621, 0x0622, 0x0623, 0x0624, 0x0625, 0x0626, 0x0627,
    0x0628, 0x0629, 0x062A, 0x062B, 0x062C, 0x062D, 0x062E, 0x062F,
    0x0630, 0x0631, 0x0632, 0x0633, 0x0634, 0x0635, 0x0636, 0x00D7,
    0x0637, 0x0638, 0x0639, 0x063A, 0x0640, 0x0641, 0x0642, 0x0643,
    0x00E0, 0x0644, 0x00E2, 0x0645, 0x0646, 0x0647, 0x0648, 0x00E7,
    0x00E8, 0x00E9, 0x00EA, 0x00EB, 0x0649, 0x064A, 0x00EE, 0x00EF,
    0x064B, 0x064C, 0x064D, 0x064E, 0x00F4, 0x064F, 0x0650, 0x00F7,
    0x0651, 0x00F9, 0x0652, 0x00FB, 0x00FC, 0x200E, 0x200F, 0x06D2,
  ];
  function decodeCp1256(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      s += String.fromCodePoint(b < 128 ? b : CP1256_HIGH[b - 128]);
    }
    return s;
  }
  const arabicCount = s => (String(s).match(/[\u0600-\u06FF]/g) || []).length;
  function decodeTextBuffer(buffer) {
    const u = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    if (u.length >= 3 && u[0] === 0xEF && u[1] === 0xBB && u[2] === 0xBF)
      return new TextDecoder('utf-8').decode(u.subarray(3));
    if (u.length >= 2 && u[0] === 0xFF && u[1] === 0xFE)
      return new TextDecoder('utf-16le').decode(u.subarray(2));
    if (u.length >= 2 && u[0] === 0xFE && u[1] === 0xFF)
      return new TextDecoder('utf-16be').decode(u.subarray(2));
    let utf8 = null;
    try { utf8 = new TextDecoder('utf-8', { fatal: true }).decode(u); } catch (e) { /* not UTF-8 */ }
    if (utf8 !== null) {
      // A CP1256 file can occasionally pass the UTF-8 validator. Prefer the
      // decoding that yields clearly more Arabic letters.
      const cp = decodeCp1256(u);
      if (arabicCount(cp) > arabicCount(utf8) * 1.5) return cp;
      return utf8;
    }
    return decodeCp1256(u);
  }

  // ---- audio sniffing / WAV helpers --------------------------------------
  function sniffAudioExt(u) {
    if (!u || u.length < 4) return '';
    if (u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46) return 'wav';
    if (u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) return 'mp3';
    if (u[0] === 0xFF && (u[1] & 0xE0) === 0xE0) return 'mp3';
    if (u[0] === 0x4F && u[1] === 0x67 && u[2] === 0x67 && u[3] === 0x53) return 'ogg';
    if (u[0] === 0x66 && u[1] === 0x4C && u[2] === 0x61 && u[3] === 0x43) return 'flac';
    if (u[0] === 0x66 && u[1] === 0x74 && u[2] === 0x79 && u[3] === 0x70) return 'm4a';
    return '';
  }
  function wavHeader(dataLen, rate, ch, bits) {
    const b = new DataView(new ArrayBuffer(44));
    const w = (o, s) => [...s].forEach((x, i) => b.setUint8(o + i, x.charCodeAt(0)));
    w(0, 'RIFF'); b.setUint32(4, 36 + dataLen, true); w(8, 'WAVEfmt ');
    b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, ch, true);
    b.setUint32(24, rate, true); b.setUint32(28, rate * ch * bits / 8, true);
    b.setUint16(32, ch * bits / 8, true); b.setUint16(34, bits, true);
    w(36, 'data'); b.setUint32(40, dataLen, true);
    return new Uint8Array(b.buffer);
  }
  function wavFromPcm(pcm, rate = 24000, ch = 1, bits = 16) {
    const h = wavHeader(pcm.length, rate, ch, bits);
    const o = new Uint8Array(44 + pcm.length);
    o.set(h); o.set(pcm, 44);
    return o;
  }
  function parseWav(u) {
    const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    let rate = 24000, ch = 1, bits = 16, o = 12;
    while (o + 8 <= u.length) {
      const id = String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
      let sz = dv.getUint32(o + 4, true);
      if (id === 'fmt ') { ch = dv.getUint16(o + 10, true); rate = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true); }
      if (id === 'data') {
        if (o + 8 + sz > u.length) sz = u.length - o - 8;
        return { rate, ch, bits, pcm: u.subarray(o + 8, o + 8 + sz) };
      }
      o += 8 + sz + (sz & 1);
    }
    return { rate, ch, bits, pcm: u.subarray(44) };
  }

  // Decode one PCM WAV part to float channels (handles 8/16/24/32-bit).
  function pcmToChannels(part) {
    const { rate, ch, bits, pcm } = part;
    const bytes = Math.max(1, bits / 8);
    const frameBytes = bytes * ch;
    const frames = Math.floor(pcm.length / frameBytes);
    const out = [];
    for (let c = 0; c < ch; c++) out.push(new Float32Array(frames));
    const dv = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < ch; c++) {
        const o = f * frameBytes + c * bytes;
        let v = 0;
        if (bits === 8) v = (dv.getUint8(o) - 128) / 128;
        else if (bits === 16) v = dv.getInt16(o, true) / 32768;
        else if (bits === 24) {
          const x = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16);
          v = (x & 0x800000 ? x - 0x1000000 : x) / 8388608;
        } else v = dv.getInt32(o, true) / 2147483648;
        out[c][f] = v;
      }
    }
    return { rate, channels: out, frames };
  }
  function resampleChannel(src, srcRate, dstRate) {
    if (srcRate === dstRate || !src.length) return src;
    const n = Math.max(1, Math.round(src.length * dstRate / srcRate));
    const out = new Float32Array(n), ratio = srcRate / dstRate;
    for (let i = 0; i < n; i++) {
      const pos = i * ratio, i0 = Math.floor(pos), frac = pos - i0;
      const a = src[Math.min(i0, src.length - 1)];
      const b = src[Math.min(i0 + 1, src.length - 1)];
      out[i] = a + (b - a) * frac;
    }
    return out;
  }
  function mapChannels(channels, dstCh) {
    if (channels.length === dstCh) return channels;
    if (channels.length === 1) return Array.from({ length: dstCh }, () => channels[0]);
    if (dstCh === 1) {
      const n = Math.min(...channels.map(c => c.length));
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0; for (const c of channels) s += c[i];
        out[i] = s / channels.length;
      }
      return [out];
    }
    return Array.from({ length: dstCh }, (_, i) => channels[Math.min(i, channels.length - 1)]);
  }
  function floatToInt16(channels) {
    const frames = channels[0].length, ch = channels.length;
    const out = new Uint8Array(frames * ch * 2);
    const dv = new DataView(out.buffer);
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < ch; c++) {
        const v = Math.max(-1, Math.min(1, channels[c][f]));
        dv.setInt16((f * ch + c) * 2, v < 0 ? v * 0x8000 : v * 0x7FFF, true);
      }
    }
    return out;
  }
  // Merge WAVs with different rates/channels/bit depths instead of rejecting.
  async function blobBytes(blob) {
    if (blob.arrayBuffer) return new Uint8Array(await blob.arrayBuffer());
    return new Promise((ok, no) => {
      const r = new FileReader();
      r.onload = () => ok(new Uint8Array(r.result));
      r.onerror = () => no(r.error || new Error('read failed'));
      r.readAsArrayBuffer(blob);
    });
  }
  async function mergeWavs(blobs) {
    if (!blobs.length) throw new Error('لا توجد ملفات للدمج');
    const parts = [];
    for (const b of blobs) parts.push(pcmToChannels(parseWav(await blobBytes(b))));
    const rate = Math.max(...parts.map(p => p.rate));
    const ch = Math.min(2, Math.max(...parts.map(p => p.channels.length)));
    const chunks = [];
    for (const p of parts) {
      const channels = mapChannels(p.channels, ch).map(c => resampleChannel(c, p.rate, rate));
      chunks.push(floatToInt16(channels));
    }
    const len = chunks.reduce((a, c) => a + c.length, 0);
    const header = wavHeader(len, rate, ch, 16);
    return new Blob([header, ...chunks], { type: 'audio/wav' });
  }

  // ---- cost estimate (real OpenRouter / Google rates) ---------------------
  // Sources (checked 2026-11-12):
  //  - Gemini 3.8 Flash TTS: $0.50/M text tokens + $9/M audio tokens.
  //  - Gemini 3.8 Flash-Lite TTS: $0.50/M + $6/M.
  //  - Fish Audio s2-pro: $15/M UTF-8 bytes; the :free variant is $0.
  //  - Google counts 25 audio tokens per second; 900 chars ≈ 1 minute.
  const TTS_PRICING = {
    'fish-audio/s2.1-pro-free:free': { free: true },
    'fish-audio/s2.1-pro': { perMBytes: 15 },
    'google/gemini-3.8-flash-tts': { inPerMTok: 0.5, outPerMTok: 9 },
    'google/gemini-3.8-flash-lite-tts': { inPerMTok: 0.5, outPerMTok: 6 },
    'google/gemini-3.1-flash-tts-preview': { inPerMTok: 1, outPerMTok: 20 },
  };
  const AUDIO_TOKENS_PER_SEC = 25, CHARS_PER_MINUTE = 900;
  function tokensEstimate(s) {
    const str = String(s == null ? '' : s);
    const a = (str.match(/[\u0600-\u06FF]/g) || []).length;
    return Math.ceil(a / 2.1 + (str.length - a) / 4);
  }
  function utf8Bytes(s) {
    try { return new TextEncoder().encode(String(s == null ? '' : s)).length; }
    catch (e) { return unescape(encodeURIComponent(String(s == null ? '' : s))).length; }
  }
  function estimateTtsCost(model, text) {
    const m = String(model || '');
    let p = TTS_PRICING[m];
    if (!p && /[:/]free(?:$|:)/i.test(m)) p = { free: true };
    if (!p) return { known: false, free: false, usd: 0, label: 'غير معروف' };
    if (p.free) return { known: true, free: true, usd: 0, label: 'مجاني' };
    if (p.perMBytes) {
      const usd = utf8Bytes(text) / 1e6 * p.perMBytes;
      return { known: true, free: false, usd, label: '$' + usd.toFixed(4) };
    }
    const inTok = tokensEstimate(text);
    const outTok = Math.ceil((String(text == null ? '' : text).length / CHARS_PER_MINUTE) * 60 * AUDIO_TOKENS_PER_SEC);
    const usd = inTok / 1e6 * p.inPerMTok + outTok / 1e6 * p.outPerMTok;
    return { known: true, free: false, usd, label: '$' + usd.toFixed(4) };
  }

  // ---- Gemini prebuilt voices (30) with verified gender metadata ----------
  // [id, Arabic character, gender]
  const GOOGLE_TTS_VOICES = [
    ['Zephyr', 'مشرق', 'female'], ['Puck', 'شاب مرح', 'male'], ['Charon', 'راوٍ معلوماتي', 'male'],
    ['Kore', 'حازم', 'female'], ['Fenrir', 'متحمس', 'male'], ['Leda', 'شبابي', 'female'],
    ['Orus', 'حازم', 'male'], ['Aoede', 'خفيف', 'female'], ['Callirrhoe', 'هادئ', 'female'],
    ['Autonoe', 'مشرق', 'female'], ['Enceladus', 'ناعم النَفَس', 'male'], ['Iapetus', 'واضح', 'male'],
    ['Umbriel', 'هادئ', 'male'], ['Algieba', 'سلس', 'male'], ['Despina', 'سلس', 'female'],
    ['Erinome', 'واضح', 'female'], ['Algenib', 'أجش', 'male'], ['Rasalgethi', 'معلوماتي', 'male'],
    ['Laomedeia', 'متحمس', 'female'], ['Achernar', 'ناعم', 'female'], ['Alnilam', 'حازم', 'male'],
    ['Schedar', 'متّزن', 'male'], ['Gacrux', 'ناضج', 'female'], ['Pulcherrima', 'جريء', 'female'],
    ['Achird', 'ودود', 'male'], ['Zubenelgenubi', 'عفوي', 'male'], ['Vindemiatrix', 'لطيف', 'female'],
    ['Sadachbia', 'حيوي', 'male'], ['Sadaltager', 'خبير', 'male'], ['Sulafat', 'دافئ', 'female'],
  ];

  // Parse a PCM mime type such as audio/L16;codec=pcm;rate=24000;channels=2.
  function pcmInfo(mime) {
    const mt = String(mime || '');
    const rateM = mt.match(/rate=(\d+)/i);
    const chM = mt.match(/channels=(\d+)/i);
    const bitsM = mt.match(/(?:bits=(\d+)|pcm[_-]?s?(\d{2})|L(\d{2}))/i);
    const bits = bitsM ? Number(bitsM[1] || bitsM[2] || bitsM[3]) : 16;
    return {
      rate: rateM ? Number(rateM[1]) : 24000,
      ch: chM ? Number(chM[1]) : 1,
      bits: bits === 8 || bits === 16 || bits === 24 || bits === 32 ? bits : 16,
    };
  }
  function pcmToWav(pcm, mime) {
    const i = pcmInfo(mime);
    return { bytes: wavFromPcm(pcm, i.rate, i.ch, i.bits), info: i };
  }

  return {
    splitAfterPunct, splitSentences, SENT_PUNCT, CLAUSE_PUNCT, storyTitle,
    decodeCp1256, decodeTextBuffer, arabicCount,
    sniffAudioExt, wavHeader, wavFromPcm, parseWav, mergeWavs, blobBytes,
    pcmToChannels, resampleChannel, floatToInt16,
    estimateTtsCost, tokensEstimate, utf8Bytes, TTS_PRICING,
    GOOGLE_TTS_VOICES, pcmInfo, pcmToWav,
  };
});
