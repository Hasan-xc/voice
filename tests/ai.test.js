// Plain Node tests for the pure AI helpers (no browser, no real API calls).
// Run: node tests/ai.test.js
const assert = require('assert');
const ai = require('../js/ai.js');

const len = s => s.length;
const text = 'الجملة الأولى هنا. الجملة الثانية! وهذه ثالثة؟\n\nفقرة جديدة تماماً تبدأ الآن.';
const norm = ai.aiNormalize(text);

// 1) Units preserve the normalized text and mark paragraph ends
{
  const units = ai.aiUnitsFromText(text, len, 40);
  assert.strictEqual(units.map(u => u.t).join(' '), norm, 'units must preserve text');
  assert.ok(units.some(u => u.p), 'at least one paragraph end must be flagged');
  assert.ok(units.every(u => len(u.t) <= 40), 'every unit must respect max');
}

// 2) A single over-limit sentence is split without cutting words
{
  const long = ('كلمة طويلة نسبياً ').repeat(12).trim();
  const units = ai.aiUnitsFromText(long, len, 25);
  assert.ok(units.length > 1);
  assert.ok(units.every(u => len(u.t) <= 25));
  assert.strictEqual(units.map(u => u.t).join(' '), ai.aiNormalize(long));
}

// 3) Breaks: sorted, unique, in range, last unit appended
assert.deepStrictEqual(ai.aiSanitizeBreaks([5, 2, 2, 99, -1, 7], 7), [2, 5, 7]);
assert.deepStrictEqual(ai.aiSanitizeBreaks([], 4), [4]);
assert.deepStrictEqual(ai.aiSanitizeBreaks(null, 0), []);

// 4) Segments are built from local units only and respect max
{
  const units = ai.aiUnitsFromText(text, len, 30);
  const segs = ai.aiSegmentsFromUnits(units, [1, 3], len, 30);
  assert.strictEqual(segs.join(' '), norm, 'segments must preserve text');
  assert.ok(segs.every(s => len(s) <= 30), 'segments must respect max');
}

// 5) An over-limit segment is split; tiny neighbours are merged when possible
{
  const units = ai.aiUnitsFromText(text, len, 1000);
  const segs = ai.aiSegmentsFromUnits(units, [], len, 35);
  assert.ok(segs.length > 1);
  assert.ok(segs.every(s => len(s) <= 35));
  assert.strictEqual(segs.join(' '), norm);

  const tiny = ai.aiSegmentsFromUnits([{ t: 'نعم', p: false }, { t: 'هذه جملة أطول بكثير', p: false }], [1], len, 100);
  assert.strictEqual(tiny.length, 1, 'tiny first segment must merge with its neighbour');
}

// 6) Model reply parsing: plain, fenced, noisy, invalid
assert.deepStrictEqual(ai.aiParseBreaks('{"breaks":[1,2]}'), [1, 2]);
assert.deepStrictEqual(ai.aiParseBreaks('```json\n{"breaks":[3]}\n```'), [3]);
assert.deepStrictEqual(ai.aiParseBreaks('مقدمة {"breaks":[4,5]} نهاية'), [4, 5]);
assert.strictEqual(ai.aiParseBreaks('لا يوجد JSON هنا'), null);

// 7) Windowing covers every unit exactly once
{
  const units = ai.aiUnitsFromText(('جملة قصيرة. ').repeat(40).trim(), len, 1000);
  const wins = ai.aiWindows(units, 60, 7);
  assert.strictEqual(wins[0][0], 0);
  assert.strictEqual(wins[wins.length - 1][1], units.length);
  for (let i = 1; i < wins.length; i++) assert.strictEqual(wins[i][0], wins[i - 1][1]);
}

// 8) Prompt carries the limit and the window numbers
{
  const units = [{ t: 'أولاً', p: false }, { t: 'ثانياً', p: true }];
  const p = ai.aiBuildPrompt(units, 0, 2, 0, len, 120, 'chars');
  assert.ok(p.includes('120'));
  assert.ok(p.includes('1.'));
  assert.ok(p.includes('2.'));
}

// 9) A fake model reply (the shape used by aiRequestBreaks) survives sanitizing
{
  const fakeReply = '{"breaks":[ 2, 2, 8, 3 ]}';
  const units = ai.aiUnitsFromText(text, len, 1000);
  const breaks = ai.aiParseBreaks(fakeReply);
  const segs = ai.aiSegmentsFromUnits(units, breaks, len, 1000);
  assert.strictEqual(segs.join(' '), norm);
}

console.log('ai.test.js: all tests passed');
