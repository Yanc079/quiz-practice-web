const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../progress-core.js');

test('章节名称会去掉题型后缀并按章节合并', () => {
  assert.equal(core.normalizeChapter('第一章 行政法总论·单项选择题'), '第一章 行政法总论');
  assert.equal(core.normalizeChapter('第一章 行政法总论·多项选择题'), '第一章 行政法总论');
  assert.equal(core.normalizeChapter('第一章 行政法总论·综合分析题'), '第一章 行政法总论');
  assert.equal(core.normalizeChapter(''), '未分类');
});

test('只有完整内容一致时公共题和个人题才会合并', async () => {
  const base = {
    text: '同一道题',
    options: [{ letter: 'A', text: '选项甲' }, { letter: 'B', text: '选项乙' }],
    correctLetter: 'A',
    explanation: '同一解析',
    knowledge: '第一章 行政法总论·单项选择题'
  };
  const merged = await core.mergeQuestions([
    { ...base, id: 'personal-1', source: 'personal' },
    { ...base, id: 'public-1', source: 'public' },
    { ...base, id: 'public-2', source: 'public', explanation: '不同解析' }
  ]);

  assert.equal(merged.length, 2);
  assert.deepEqual([...merged[0].sources].sort(), ['personal', 'public']);
  assert.deepEqual([...merged[0].allIds].sort(), ['personal-1', 'public-1']);
  assert.equal(merged[1].id, 'public-2');
});

test('综合分析题按小问生成统计单位', async () => {
  const question = {
    text: '综合题背景',
    type: 'comprehensive',
    knowledge: '第三章 行政处罚法律制度·综合分析题',
    subQuestions: [
      { text: '小问一', options: [{ letter: 'A', text: '甲' }], correctLetter: 'A' },
      { text: '小问二', options: [{ letter: 'B', text: '乙' }], correctLetter: 'B' }
    ]
  };
  const fingerprint = await core.fingerprintQuestion(question);

  assert.equal(core.getSubCount(question), 2);
  assert.deepEqual(core.unitKeys(question, fingerprint), [`${fingerprint}:1`, `${fingerprint}:2`]);
});

test('章节统计使用每个小问的最新学习状态', async () => {
  const q1 = { text: '题一', options: [{ letter: 'A', text: '甲' }], correctLetter: 'A', knowledge: '第一章 行政法总论·单项选择题' };
  const q2 = { text: '题二', options: [{ letter: 'A', text: '甲' }], correctLetter: 'A', knowledge: '第一章 行政法总论·单项选择题' };
  const fp1 = await core.fingerprintQuestion(q1);
  const fp2 = await core.fingerprintQuestion(q2);
  const questions = [
    { ...q1, fingerprint: fp1 },
    { ...q2, fingerprint: fp2 },
    { text: '题三', options: [{ letter: 'A', text: '甲' }], correctLetter: 'A', knowledge: '第二章 行政许可法律制度', fingerprint: 'unanswered' }
  ];
  const states = [
    { question_fingerprint: fp1, sub_index: 0, is_correct: true },
    { question_fingerprint: fp2, sub_index: 0, is_correct: false }
  ];

  const stats = core.computeChapterStats(questions, states);
  assert.deepEqual(stats['第一章 行政法总论'], { total: 2, done: 2, undone: 0, correct: 1, wrong: 1, accuracy: 50 });
  assert.deepEqual(stats['第二章 行政许可法律制度'], { total: 1, done: 0, undone: 1, correct: 0, wrong: 0, accuracy: 0 });
});

test('综合题题号在未答、全对和存在错误时返回不同状态', () => {
  const question = { type: 'comprehensive', subQuestions: [{}, {}, {}] };
  assert.equal(core.getTopLevelQuestionStatus(question, [null, null, null]), 'unanswered');
  assert.equal(core.getTopLevelQuestionStatus(question, [
    { isAnswered: true, isCorrect: true },
    { isAnswered: true, isCorrect: true },
    { isAnswered: true, isCorrect: true }
  ]), 'correct');
  assert.equal(core.getTopLevelQuestionStatus(question, [
    { isAnswered: true, isCorrect: true },
    { isAnswered: true, isCorrect: false },
    null
  ]), 'wrong');
});

test('累积已答只计算当前题库中存在的去重小问', async () => {
  const question = {
    text: '综合题',
    type: 'comprehensive',
    options: null,
    knowledge: '第一章',
    subQuestions: [
      { text: '一', options: [{ letter: 'A', text: '甲' }], correctLetter: 'A' },
      { text: '二', options: [{ letter: 'B', text: '乙' }], correctLetter: 'B' }
    ]
  };
  const fingerprint = await core.fingerprintQuestion(question);
  const result = core.computeCumulative([
    { ...question, fingerprint }
  ], [
    { question_fingerprint: fingerprint, sub_index: 1, is_correct: true },
    { question_fingerprint: 'deleted-question', sub_index: 0, is_correct: true }
  ]);

  assert.deepEqual(result, { done: 1, total: 2 });
});
