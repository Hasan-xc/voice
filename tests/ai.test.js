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

// 10) Tag whitelists and text comparison (director)
assert.ok(ai.aiTagList('gemini').includes('short pause'));
assert.ok(ai.aiTagList('gemini').includes('laugh'));
assert.ok(ai.aiTagList('fish').includes('whisper'));
assert.strictEqual(ai.aiStripTags('مرحبا <laugh> بالعالم', 'gemini'), 'مرحبا بالعالم');
assert.strictEqual(ai.aiStripTags('مرحبا <short pause> بالعالم', 'gemini'), 'مرحبا بالعالم');
assert.strictEqual(ai.aiStripTags('مرحبا <throat-clearing> بالعالم', 'gemini'), 'مرحبا بالعالم');
assert.strictEqual(ai.aiStripTags('مرحبا [long pause] بالعالم', 'fish'), 'مرحبا بالعالم');
assert.ok(ai.aiTextMatches('مرحبا بالعالم', 'مرحبا <laugh> بالعالم', 'gemini'));
assert.ok(!ai.aiTextMatches('مرحبا بالعالم', 'مرحبا <unknown> بالعالم', 'gemini'));
assert.ok(ai.aiTextMatches('مرحبا', '[whisper] مرحبا', 'fish'));
assert.ok(!ai.aiTextMatches('مرحبا', '<whisper> مرحبا', 'fish'));
assert.ok(ai.aiTextMatches('مرحبا <sigh>', 'مرحبا', 'gemini'));

// 11) Director item parsing + style cleaning
assert.deepStrictEqual(ai.aiParseDirectorItems('{"items":[{"i":1,"style":"هادئ"}]}'), [{ i: 1, style: 'هادئ' }]);
assert.strictEqual(ai.aiParseDirectorItems('nope'), null);
assert.strictEqual(ai.aiCleanStyle('  هادئ   ودافئ '), 'هادئ ودافئ');

// 12) Speaker labels + speaker-split validation
assert.strictEqual(ai.aiCleanSpeaker('  الراوي   الأول '), 'الراوي الأول');
assert.strictEqual(ai.aiCleanSpeaker(null), '');
{
  const orig = 'قال الطفل: ماما، أريد الحلوى. فأجابت الأم: بعد الغداء.';
  assert.ok(ai.aiPartsValid(orig, [
    { text: 'قال الطفل: ماما، أريد الحلوى.' },
    { text: 'فأجابت الأم: بعد الغداء.' }
  ], 'gemini'));
  assert.ok(!ai.aiPartsValid(orig, [
    { text: 'قال الطفل: ماما.' },
    { text: 'فأجابت الأم: بعد الغداء.' }
  ], 'gemini'), 'a split must not drop text');
  assert.ok(ai.aiPartsValid('مرحبا <laugh> بالعالم', [
    { text: 'مرحبا <laugh>' }, { text: 'بالعالم' }
  ], 'gemini'), 'allowed tags are ignored when comparing');
  assert.ok(!ai.aiPartsValid('مرحبا بالعالم', [
    { text: 'مرحبا' }, { text: '<laugh>' }
  ], 'gemini'), 'a tag-only part is invalid');
  assert.ok(!ai.aiPartsValid(orig, [{ text: orig }], 'gemini'), 'a split needs at least two parts');
}

// 13) Speaker plan: characters, verbatim source, clean spoken text
{
  const raw = JSON.stringify({
    characters: [
      { name: ' عمار ', gender: 'male', age: 'شاب', desc: 'متحمس', voice: 'Puck' },
      { name: 'رنا', gender: 'أنثى', age: 'متوسطة العمر', desc: 'هادئة', voice: 'Kore' },
      { name: 'عمار', gender: 'male', voice: 'Zephyr' }
    ],
    lines: [
      { speaker: 'عمار', source: 'عمار: مابكم يا شباب هيا..', text: 'مابكم يا شباب هيا..', emotion: 'حماس' },
      { speaker: 'رنا', source: 'رنا: مالذي تفعلونه؟', text: 'رنا: مالذي تفعلونه؟', emotion: 'دهشة' }
    ]
  });
  const p = ai.aiParseSpeakerPlan(raw);
  assert.strictEqual(p.characters.length, 2, 'duplicate names collapse');
  assert.strictEqual(p.characters[0].name, 'عمار');
  assert.strictEqual(p.characters[0].gender, 'male');
  assert.strictEqual(p.characters[1].gender, 'female');
  assert.strictEqual(p.lines.length, 2);
  assert.strictEqual(p.lines[0].text, 'مابكم يا شباب هيا..');
  assert.strictEqual(p.lines[0].source, 'عمار: مابكم يا شباب هيا..');
  assert.strictEqual(p.lines[1].text, 'مالذي تفعلونه؟', 'speaker prefix is stripped from the chunk text');
  assert.strictEqual(p.lines[1].emotion, 'دهشة');
  assert.strictEqual(ai.aiParseSpeakerPlan('nope'), null);
  assert.strictEqual(ai.aiParseSpeakerPlan('{"lines":[]}'), null);
}

// 14) Plan validation tolerates punctuation but not dropped words
assert.ok(ai.aiSpeechSame('عمار: مابكم يا شباب هيا..', 'عمار مابكم يا شباب هيا', 'gemini'));
assert.ok(!ai.aiSpeechSame('عمار: مابكم يا شباب هيا..', 'مابكم يا شباب', 'gemini'));
assert.ok(ai.aiSpeechSame('مرحبا <laugh> بالعالم', 'مرحبا بالعالم', 'gemini'));

// 15) Fallback lines never lose the window text
{
  const src = 'جملة أولى. جملة ثانية! جملة ثالثة؟';
  const lines = ai.aiFallbackLines(src);
  assert.strictEqual(lines.length, 3);
  assert.strictEqual(lines.map(l => l.text).join(' '), src);
  assert.ok(lines.every(l => l.speaker === ''));
}

// 16) Finalizing the plan: every speaker gets one valid, distinct voice
{
  const catalog = [
    { id: 'Puck', gender: 'male', age: '30' },
    { id: 'Fenrir', gender: 'male' },
    { id: 'Kore', gender: 'female' },
    { id: 'Zephyr', gender: 'female' }
  ];
  const plan = {
    characters: [
      { name: 'عمار', gender: 'male', voice: 'NOPE' },
      { name: 'رنا', gender: 'female', voice: '' }
    ],
    lines: [
      { speaker: 'عمار', source: 'عمار: أهلاً', text: 'أهلاً' },
      { speaker: 'رنا', source: 'رنا: مرحباً', text: 'مرحباً' },
      { speaker: 'خالد', source: 'خالد: السلام', text: 'السلام' }
    ]
  };
  const fin = ai.aiFinalizePlan(plan, catalog);
  assert.strictEqual(fin.characters.length, 3, 'line speakers are added');
  const ammar = fin.characters.find(c => c.name === 'عمار');
  const rana = fin.characters.find(c => c.name === 'رنا');
  assert.strictEqual(ammar.voice, 'Puck', 'invalid voice is replaced by a male voice');
  assert.strictEqual(rana.voice, 'Kore', 'female voice is chosen');
  assert.notStrictEqual(ammar.voice, rana.voice);
}

// 17) Chunks contain the spoken line only, with the approved character voice
{
  const plan = {
    characters: [
      { name: 'عمار', gender: 'male', voice: 'Puck' },
      { name: 'رنا', gender: 'female', voice: 'Kore' }
    ],
    lines: [
      { speaker: 'عمار', text: 'مابكم يا شباب هيا..', style: 'متحمس' },
      { speaker: 'رنا', text: '<gasp> مالذي تفعلونه؟', emotion: 'دهشة' }
    ]
  };
  const map = { [ai.aiCharKey('عمار')]: 'Puck', [ai.aiCharKey('رنا')]: 'Kore' };
  const chunks = ai.aiBuildSpeakerChunks(plan, { voices: map });
  assert.strictEqual(chunks.length, 2);
  assert.strictEqual(chunks[0].text, 'مابكم يا شباب هيا..');
  assert.ok(!chunks[0].text.includes('عمار'));
  assert.strictEqual(chunks[0].voice, 'Puck');
  assert.strictEqual(chunks[1].voice, 'Kore');
  assert.ok(chunks[1].text.includes('<gasp>'), 'emotion tag stays in the chunk');
  assert.strictEqual(chunks[0].name, '1');
  assert.strictEqual(chunks[1].speaker, 'رنا');
}

// 18) The prompt is explicit about verbatim source and speaker splitting
{
  const sys = ai.aiSpeakerSystem('gemini', { tags: true, style: true, voices: true });
  assert.ok(sys.includes('source'));
  assert.ok(sys.includes('بدون «الاسم:»'));
  assert.ok(sys.includes('تغيّر متحدث'));
  assert.ok(sys.includes('<gasp>'));
  assert.ok(sys.includes('availableVoices'));
}

console.log('ai.test.js: all tests passed');
