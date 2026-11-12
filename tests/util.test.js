// Node tests for js/util.js (pure helpers, no DOM).
const assert = require('node:assert');
const u = require('../js/util.js');

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok -', name); };

t('splitAfterPunct keeps punctuation and splits on whitespace', () => {
  const out = u.splitAfterPunct('أهلاً. كيف حالك؟ بخير', u.SENT_PUNCT);
  assert.deepStrictEqual(out, ['أهلاً.', 'كيف حالك؟', 'بخير']);
});

t('splitAfterPunct does not split decimals or abbreviations mid-token', () => {
  assert.deepStrictEqual(u.splitAfterPunct('3.14 ثم 2.5', u.SENT_PUNCT), ['3.14 ثم 2.5']);
});

t('splitSentences keeps paragraphs and Arabic punctuation', () => {
  const out = u.splitSentences('سطر أول.\n\nسطر ثانٍ! هل تم؟');
  assert.deepStrictEqual(out, ['سطر أول.', 'سطر ثانٍ!', 'هل تم؟']);
});

t('CP1256 decodes Arabic bytes', () => {
  assert.strictEqual(u.decodeCp1256(Uint8Array.from([0xC7, 0xE1, 0xD3])), 'الس');
});

t('decodeTextBuffer detects UTF-8, UTF-16LE and CP1256', () => {
  const utf8 = new TextEncoder().encode('مرحباً');
  assert.strictEqual(u.decodeTextBuffer(utf8), 'مرحباً');
  const bom8 = new Uint8Array([0xEF, 0xBB, 0xBF, ...utf8]);
  assert.strictEqual(u.decodeTextBuffer(bom8), 'مرحباً');
  const le = new Uint8Array([0xFF, 0xFE, ...Buffer.from('مرحباً', 'utf16le')]);
  assert.strictEqual(u.decodeTextBuffer(le), 'مرحباً');
  const cp = Uint8Array.from([0xC7, 0xE1, 0xD3, 0xE1, 0xC7, 0xE3]);
  assert.strictEqual(u.decodeTextBuffer(cp), 'السلام');
});

t('sniffAudioExt recognises common containers', () => {
  assert.strictEqual(u.sniffAudioExt(Uint8Array.from([0x52, 0x49, 0x46, 0x46])), 'wav');
  assert.strictEqual(u.sniffAudioExt(Uint8Array.from([0x49, 0x44, 0x33, 0x04])), 'mp3');
  assert.strictEqual(u.sniffAudioExt(Uint8Array.from([0xFF, 0xFB, 0x90, 0x00])), 'mp3');
  assert.strictEqual(u.sniffAudioExt(Uint8Array.from([0x4F, 0x67, 0x67, 0x53])), 'ogg');
  assert.strictEqual(u.sniffAudioExt(Uint8Array.from([0x66, 0x4C, 0x61, 0x43])), 'flac');
  assert.strictEqual(u.sniffAudioExt(Uint8Array.from([1, 2, 3, 4])), '');
});

t('pcmInfo parses rate/channels/bit depth from mime', () => {
  assert.deepStrictEqual(u.pcmInfo('audio/L16;codec=pcm;rate=24000;channels=1'), { rate: 24000, ch: 1, bits: 16 });
  assert.deepStrictEqual(u.pcmInfo('audio/pcm;rate=48000;channels=2'), { rate: 48000, ch: 2, bits: 16 });
  assert.deepStrictEqual(u.pcmInfo('audio/pcm;rate=16000;channels=2;bits=24'), { rate: 16000, ch: 2, bits: 24 });
  assert.deepStrictEqual(u.pcmInfo(''), { rate: 24000, ch: 1, bits: 16 });
});

t('pcmToWav writes a valid header for stereo 24-bit', () => {
  const pcm = new Uint8Array(6 * 2 * 3); // 6 frames, stereo, 24-bit
  const { bytes, info } = u.pcmToWav(pcm, 'audio/L24;rate=48000;channels=2');
  assert.strictEqual(info.rate, 48000);
  assert.strictEqual(info.ch, 2);
  assert.strictEqual(info.bits, 24);
  assert.strictEqual(bytes.length, 44 + pcm.length);
  const back = u.parseWav(bytes);
  assert.strictEqual(back.rate, 48000);
  assert.strictEqual(back.ch, 2);
  assert.strictEqual(back.bits, 24);
  assert.strictEqual(back.pcm.length, pcm.length);
});

const sineWav = (rate, ch, bits, ms) => {
  const frames = Math.round(rate * ms / 1000);
  const bytes = bits / 8;
  const pcm = new Uint8Array(frames * ch * bytes);
  const dv = new DataView(pcm.buffer);
  for (let f = 0; f < frames; f++) {
    const v = Math.round(Math.sin(2 * Math.PI * 440 * f / rate) * (bits === 16 ? 12000 : 100));
    for (let c = 0; c < ch; c++) {
      const o = (f * ch + c) * bytes;
      if (bits === 16) dv.setInt16(o, v, true);
      else if (bits === 8) pcm[o] = 128 + v;
    }
  }
  return u.wavFromPcm(pcm, rate, ch, bits);
};

t('mergeWavs resamples 16k mono + 48k stereo into one WAV', async () => {
  const a = new Blob([sineWav(16000, 1, 16, 200)]);
  const b = new Blob([sineWav(48000, 2, 16, 200)]);
  const merged = await u.mergeWavs([a, b]);
  const bytes = new Uint8Array(await merged.arrayBuffer());
  const info = u.parseWav(bytes);
  assert.strictEqual(info.rate, 48000);
  assert.strictEqual(info.ch, 2);
  assert.strictEqual(info.bits, 16);
  assert.ok(info.pcm.length > 0);
  // ~400ms at 48k stereo 16-bit, allow interpolation rounding.
  const frames = info.pcm.length / 4;
  assert.ok(Math.abs(frames - 19200) < 60, 'frames=' + frames);
});

t('mergeWavs handles 8-bit input', async () => {
  const merged = await u.mergeWavs([new Blob([sineWav(8000, 1, 8, 100)])]);
  const info = u.parseWav(new Uint8Array(await merged.arrayBuffer()));
  assert.strictEqual(info.rate, 8000);
  assert.strictEqual(info.bits, 16);
});

t('estimateTtsCost: free model is zero', () => {
  const r = u.estimateTtsCost('fish-audio/s2.1-pro-free:free', 'نص');
  assert.strictEqual(r.known, true);
  assert.strictEqual(r.free, true);
  assert.strictEqual(r.usd, 0);
});

t('estimateTtsCost: Fish paid uses UTF-8 bytes at $15/M', () => {
  const r = u.estimateTtsCost('fish-audio/s2.1-pro', 'abc');
  assert.ok(Math.abs(r.usd - 3 / 1e6 * 15) < 1e-12, String(r.usd));
});

t('estimateTtsCost: Gemini uses input + audio output tokens', () => {
  const r = u.estimateTtsCost('google/gemini-3.8-flash-tts', 'a'.repeat(900));
  // 900 chars ~ 1 min -> 1500 audio tokens; 225 text tokens.
  assert.ok(r.usd > 0);
  const expected = 225 / 1e6 * 0.5 + 1500 / 1e6 * 9;
  assert.ok(Math.abs(r.usd - expected) < 1e-9, r.usd + ' vs ' + expected);
});

t('estimateTtsCost: unknown model is flagged', () => {
  const r = u.estimateTtsCost('nope/model', 'x');
  assert.strictEqual(r.known, false);
});

t('Google voice catalog has 30 unique voices with gender', () => {
  assert.strictEqual(u.GOOGLE_TTS_VOICES.length, 30);
  const ids = new Set(u.GOOGLE_TTS_VOICES.map(v => v[0]));
  assert.strictEqual(ids.size, 30);
  assert.ok(u.GOOGLE_TTS_VOICES.every(v => v[2] === 'male' || v[2] === 'female'));
  assert.ok(u.GOOGLE_TTS_VOICES.some(v => v[0] === 'Zephyr' && v[2] === 'female'));
});

console.log(`util.test.js: all ${n} tests passed`);
