(function initProgressCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.QuizProgressCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createProgressCore() {
  'use strict';

  const RUNTIME_FIELDS = new Set(['id', 'source', 'sources', 'questionKey', 'fingerprint', 'cloudUpdatedAt', 'letterMap']);

  function canonicalize(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
    const entries = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${entries.join(',')}}`;
  }

  function stripRuntimeFields(value) {
    if (Array.isArray(value)) return value.map(stripRuntimeFields);
    if (value === null || typeof value !== 'object') return value;
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (!RUNTIME_FIELDS.has(key)) result[key] = stripRuntimeFields(child);
    }
    return result;
  }

  function questionContent(question) {
    return stripRuntimeFields(JSON.parse(JSON.stringify(question || {})));
  }

  async function fingerprintQuestion(question) {
    const canonical = canonicalize(questionContent(question));
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function normalizeChapter(knowledge) {
    const chapter = String(knowledge || '')
      .split('·')[0]
      .replace(/单项选择题|多项选择题|综合分析题/g, '')
      .trim();
    return chapter || '未分类';
  }

  async function mergeQuestions(questionList) {
    const byContent = new Map();
    for (const original of questionList || []) {
      const content = canonicalize(questionContent(original));
      const source = original.source === 'public' ? 'public' : 'personal';
      const existing = byContent.get(content);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        continue;
      }
      const fingerprint = await fingerprintQuestion(original);
      byContent.set(content, {
        ...JSON.parse(JSON.stringify(original)),
        fingerprint,
        chapter: normalizeChapter(original.knowledge),
        sources: [source]
      });
    }
    return [...byContent.values()];
  }

  function isComprehensive(question) {
    return Boolean(question && question.type === 'comprehensive' && Array.isArray(question.subQuestions));
  }

  function getSubCount(question) {
    return isComprehensive(question) ? question.subQuestions.length : 1;
  }

  function unitKeys(question, fingerprint = question?.fingerprint) {
    if (!fingerprint) return [];
    if (isComprehensive(question)) return question.subQuestions.map((_, index) => `${fingerprint}:${index + 1}`);
    return [`${fingerprint}:0`];
  }

  function indexStates(states) {
    const map = new Map();
    for (const state of states || []) {
      map.set(`${state.question_fingerprint}:${state.sub_index}`, state);
    }
    return map;
  }

  function computeChapterStats(questions, states) {
    const stateMap = indexStates(states);
    const stats = {};
    for (const question of questions || []) {
      const chapter = normalizeChapter(question.chapter || question.knowledge);
      if (!stats[chapter]) stats[chapter] = { total: 0, done: 0, undone: 0, correct: 0, wrong: 0, accuracy: 0 };
      const item = stats[chapter];
      item.total += getSubCount(question);
      for (const key of unitKeys(question)) {
        const state = stateMap.get(key);
        if (!state) continue;
        item.done++;
        if (state.is_correct) item.correct++;
        else item.wrong++;
      }
      item.undone = item.total - item.done;
      item.accuracy = item.done > 0 ? Number((item.correct / item.done * 100).toFixed(1)) : 0;
    }
    return stats;
  }

  function computeCumulative(questions, states) {
    const validKeys = new Set();
    for (const question of questions || []) {
      for (const key of unitKeys(question)) validKeys.add(key);
    }
    const done = new Set(
      (states || [])
        .map(state => `${state.question_fingerprint}:${state.sub_index}`)
        .filter(key => validKeys.has(key))
    );
    return { done: done.size, total: validKeys.size };
  }

  function getTopLevelQuestionStatus(question, answers) {
    const normalized = isComprehensive(question)
      ? Array.from({ length: question.subQuestions.length }, (_, index) => answers?.[index] || null)
      : [answers?.[0] || answers || null];
    const answered = normalized.filter(answer => answer?.isAnswered);
    if (answered.length === 0) return 'unanswered';
    return answered.length === normalized.length && answered.every(answer => answer.isCorrect)
      ? 'correct'
      : 'wrong';
  }

  return {
    canonicalize,
    questionContent,
    fingerprintQuestion,
    normalizeChapter,
    mergeQuestions,
    isComprehensive,
    getSubCount,
    unitKeys,
    computeChapterStats,
    computeCumulative,
    getTopLevelQuestionStatus
  };
});
