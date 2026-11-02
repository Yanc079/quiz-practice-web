(() => {
  'use strict';

  const config = window.QUIZ_CONFIG || {};
  const state = {
    client: null,
    user: null,
    profile: null,
    authMode: 'login',
    appStarted: false,
    bootingUserId: null,
    suppressSync: false,
    wrongTimer: null,
    favoriteTimer: null,
    syncingWrong: false,
    syncingFavorites: false,
    serverWrongIds: new Set(),
    serverFavoriteIds: new Set(),
    pendingEmail: '',
    historyExpanded: new Set(),
    selectedHistoryQuestion: new Map(),
    sessionQuestionCache: new Map(),
    learningStates: [],
    activePractice: null,
    activeSaveTimer: null,
    activeSavePromise: null,
    activeDirty: false,
    learningRevision: 0
  };

  const $ = id => document.getElementById(id);
  const routeNotice = { timer: null };

  function cloudEscape(value) {
    if (value == null) return '';
    return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function makeUuid() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, ch => {
      const n = Math.random() * 16 | 0;
      return (ch === 'x' ? n : ((n & 0x3) | 0x8)).toString(16);
    });
  }

  function showToast(message, type = 'info') {
    let el = document.getElementById('cloudToast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cloudToast';
      Object.assign(el.style, {
        position: 'fixed', right: '20px', bottom: '20px', zIndex: '10050', maxWidth: 'min(420px, calc(100vw - 40px))',
        padding: '12px 16px', borderRadius: '14px', boxShadow: '0 10px 30px rgba(15,23,42,.22)', font: '14px/1.5 system-ui, sans-serif',
        transition: 'opacity .2s, transform .2s', opacity: '0', transform: 'translateY(8px)'
      });
      document.body.appendChild(el);
    }
    const colors = type === 'error' ? ['#7f1d1d', '#fef2f2'] : type === 'success' ? ['#14532d', '#f0fdf4'] : ['#1e3a5f', '#eff6ff'];
    el.style.color = colors[0];
    el.style.background = colors[1];
    el.textContent = message;
    requestAnimationFrame(() => { el.style.opacity = '1'; el.style.transform = 'translateY(0)'; });
    clearTimeout(routeNotice.timer);
    routeNotice.timer = setTimeout(() => { el.style.opacity = '0'; el.style.transform = 'translateY(8px)'; }, 4200);
  }

  function setAuthNotice(message, type = 'info') {
    const el = $('authNotice');
    if (!el) return;
    el.className = `auth-notice ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`.trim();
    el.textContent = message || '';
    el.classList.toggle('hidden', !message);
  }

  function setAuthBusy(busy, label = '处理中...') {
    const btn = $('authSubmitBtn');
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? label : (state.authMode === 'login' ? '登录' : '提交注册');
  }

  function setAuthMode(mode) {
    state.authMode = mode === 'signup' ? 'signup' : 'login';
    const isSignup = state.authMode === 'signup';
    $('authTitle').textContent = isSignup ? '申请账号' : '登录答题器';
    $('authSubtitle').textContent = isSignup ? '注册后需由超级管理员审核，通过后才能读取数据' : '登录后才能访问题库和学习记录';
    $('authNameField').classList.toggle('hidden', !isSignup);
    $('authName').required = isSignup;
    $('authSubmitBtn').textContent = isSignup ? '提交注册' : '登录';
    $('authSwitchBtn').textContent = isSignup ? '已有账号？返回登录' : '没有账号？申请注册';
    $('authPassword').autocomplete = isSignup ? 'new-password' : 'current-password';
    setAuthNotice('');
  }

  function showAuthForm() {
    $('authScreen').classList.remove('hidden');
    $('appShell').classList.add('hidden');
    $('authStatusCard').classList.add('hidden');
    $('authForm').classList.remove('hidden');
    $('authSwitchBtn').classList.remove('hidden');
    setAuthBusy(false);
  }

  function showAccountStatus(icon, title, text) {
    $('authScreen').classList.remove('hidden');
    $('appShell').classList.add('hidden');
    $('authForm').classList.add('hidden');
    $('authSwitchBtn').classList.add('hidden');
    $('authResendBtn').classList.add('hidden');
    $('authStatusCard').classList.remove('hidden');
    $('authStatusIcon').textContent = icon;
    $('authStatusTitle').textContent = title;
    $('authStatusText').textContent = text;
  }

  function clearClientData() {
    ['user_bank_tax_v22', 'public_bank_tax_v22', 'merged_bank_tax_v23', 'wrongList_tax_v22', 'favorites_tax_v22', 'active_practice_tax_v23', 'pending_learning_states_v1'].forEach(key => localStorage.removeItem(key));
    if (typeof globalMasterList !== 'undefined') globalMasterList = [];
    if (typeof wrongList !== 'undefined') wrongList = [];
    if (typeof favoritesList !== 'undefined') favoritesList = [];
    if (typeof learningStates !== 'undefined') learningStates = [];
    if (typeof currentSession !== 'undefined') currentSession = null;
    state.learningStates = [];
    state.activePractice = null;
    state.sessionQuestionCache = new Map();
    state.selectedHistoryQuestion = new Map();
    state.historyExpanded = new Set();
    state.serverWrongIds = new Set();
    state.serverFavoriteIds = new Set();
  }

  function friendlyAuthError(error) {
    const message = String(error?.message || error || '').toLowerCase();
    if (message.includes('invalid login credentials')) return '邮箱或密码错误';
    if (message.includes('email not confirmed')) return '邮箱尚未验证，请先点击验证邮件中的链接';
    if (message.includes('user already registered')) return '该邮箱已经注册，请直接登录';
    if (message.includes('password should be')) return '密码长度至少为 6 位';
    if (message.includes('rate limit')) return '操作过于频繁，请稍后再试';
    return error?.message || '操作失败，请稍后重试';
  }

  async function signOutAndReload() {
    try { await flushActivePractice(); } catch (_) { /* 退出时仍继续清理本地状态 */ }
    clearClientData();
    try { await state.client?.auth.signOut(); } catch (_) { /* 页面仍会刷新以清理界面 */ }
    window.location.reload();
  }

  async function handleAuthSubmit(event) {
    event.preventDefault();
    if (!state.client) return;
    const email = $('authEmail').value.trim();
    const password = $('authPassword').value;
    const displayName = $('authName').value.trim();
    if (!email || password.length < 6) { setAuthNotice('请输入有效邮箱，密码至少 6 位', 'error'); return; }
    setAuthBusy(true);
    setAuthNotice('');
    try {
      if (state.authMode === 'signup') {
        state.pendingEmail = email;
        const { data, error } = await state.client.auth.signUp({
          email,
          password,
          options: { data: { display_name: displayName || email.split('@')[0] } }
        });
        if (error) throw error;
        if (data.session) {
          await routeSession(data.session);
        } else {
          setAuthMode('login');
          setAuthNotice('注册申请已提交。请完成邮箱验证；首次使用的初始化账号将自动成为超级管理员。', 'success');
          $('authResendBtn').classList.remove('hidden');
        }
      } else {
        state.pendingEmail = email;
        const { data, error } = await state.client.auth.signInWithPassword({ email, password });
        if (error) throw error;
        await routeSession(data.session);
      }
    } catch (error) {
      const msg = friendlyAuthError(error);
      setAuthNotice(msg, 'error');
      if (/验证|confirmed/i.test(msg)) $('authResendBtn').classList.remove('hidden');
    } finally {
      setAuthBusy(false);
    }
  }

  async function resendVerification() {
    const email = state.pendingEmail || $('authEmail').value.trim();
    if (!email) { setAuthNotice('请先填写邮箱', 'error'); return; }
    setAuthNotice('正在发送验证邮件...');
    const { error } = await state.client.auth.resend({ type: 'signup', email });
    setAuthNotice(error ? friendlyAuthError(error) : '验证邮件已发送，请检查收件箱和垃圾邮件。', error ? 'error' : 'success');
  }

  async function loadOwnProfile(userId) {
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const { data, error } = await state.client.from('profiles').select('id,email,display_name,role,status,created_at').eq('id', userId).maybeSingle();
      if (data) return data;
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, 350));
    }
    if (lastError) throw lastError;
    return null;
  }

  async function routeSession(session) {
    if (!session?.user) {
      state.user = null;
      state.profile = null;
      clearClientData();
      setAuthMode('login');
      showAuthForm();
      return;
    }
    if (state.appStarted && state.user?.id === session.user.id) return;
    if (state.bootingUserId === session.user.id) return;
    state.bootingUserId = session.user.id;
    try {
      const profile = await loadOwnProfile(session.user.id);
      if (!profile) {
        await signOutAndReload();
        return;
      }
      state.user = session.user;
      state.profile = profile;
      if (profile.status === 'pending') {
        clearClientData();
        setAuthNotice('');
        showAccountStatus('⏳', '账号等待审核', '注册已成功。请联系超级管理员审核，通过后重新登录即可使用。');
        return;
      }
      if (profile.status === 'suspended') {
        clearClientData();
        setAuthNotice('');
        showAccountStatus('⛔', '账号已暂停', '当前账号已被管理员暂停访问，请联系超级管理员。');
        return;
      }
      if (profile.status !== 'active') {
        throw new Error('账号状态异常');
      }
      await enterApp();
    } catch (error) {
      console.error(error);
      showAuthForm();
      setAuthNotice(`无法进入答题器：${friendlyAuthError(error)}`, 'error');
    } finally {
      state.bootingUserId = null;
    }
  }

  async function fetchAll(table, select = '*', orderColumn = 'created_at', ascending = true) {
    const rows = [];
    const pageSize = 1000;
    let from = 0;
    while (true) {
      let query = state.client.from(table).select(select).range(from, from + pageSize - 1);
      if (orderColumn) query = query.order(orderColumn, { ascending });
      const { data, error } = await query;
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
    return rows;
  }

  function rowToQuestion(row, source) {
    const payload = row.payload && typeof row.payload === 'object' ? JSON.parse(JSON.stringify(row.payload)) : {};
    payload.id = String(row.id);
    payload.source = source;
    payload.questionKey = row.question_key;
    payload.cloudUpdatedAt = row.updated_at;
    return payload;
  }

  function updateRoleUi() {
    const isAdmin = state.profile?.role === 'super_admin' && state.profile?.status === 'active';
    $('userAdminNav')?.classList.toggle('hidden', !isAdmin);
    $('publicUploadLabel')?.classList.toggle('hidden', !isAdmin);
    $('resetPublicBankBtn')?.classList.toggle('hidden', !isAdmin);
    $('publicUploadHint')?.classList.toggle('hidden', !isAdmin);
    const display = state.profile?.display_name || state.profile?.email || '用户';
    $('accountName').textContent = `${display}${isAdmin ? ' · 超级管理员' : ''}`;
  }

  async function migrateLegacyLocalData(localSnapshot, personalRows, wrongRows, favoriteRows) {
    const hasLocalData = localSnapshot.questions.length > 0 || localSnapshot.wrong.length > 0 || localSnapshot.favorites.length > 0;
    const cloudHasLearningData = personalRows.length > 0 || wrongRows.length > 0 || favoriteRows.length > 0;
    if (!hasLocalData || cloudHasLearningData) return null;
    if (!confirm('检测到本机有旧版题库或学习记录，是否上传到当前账号并开启跨设备同步？')) return null;

    const uniqueQuestions = [];
    const seen = new Set();
    localSnapshot.questions.forEach(question => {
      const key = window.QuizProgressCore.canonicalize(window.QuizProgressCore.questionContent(question));
      if (!key || seen.has(key)) return;
      seen.add(key);
      uniqueQuestions.push(question);
    });
    if (uniqueQuestions.length) await uploadQuestions(uniqueQuestions, 'personal');

    const latestPersonalRows = await fetchAll('personal_questions', 'id,question_key,payload,created_at,updated_at');
    const newByText = new Map();
    latestPersonalRows.forEach(row => {
      const text = String(row.payload?.text || '').trim();
      if (text && !newByText.has(text)) newByText.set(text, String(row.id));
    });
    const resolveOldQuestionId = qid => {
      const numericIndex = Number(qid);
      const legacy = Number.isInteger(numericIndex) && numericIndex > 0
        ? localSnapshot.questions[numericIndex - 1]
        : localSnapshot.questions.find(question => String(question.id) === String(qid));
      if (!legacy) return null;
      return newByText.get(String(legacy.text || '').trim()) || null;
    };

    const migratedWrongRows = localSnapshot.wrong.map(item => {
      const questionId = resolveOldQuestionId(item.qid);
      if (!questionId) return null;
      return {
        user_id: state.user.id,
        question_id: questionId,
        question_source: 'personal',
        wrong_count: Math.max(1, Number(item.wrongCount) || 1),
        last_user_choice_texts: item.lastUserChoiceTexts || null,
        last_sub_choice_texts: item.lastSubChoiceTexts || null,
        last_time: new Date(item.lastTime || Date.now()).toISOString()
      };
    }).filter(Boolean);
    const migratedFavoriteRows = localSnapshot.favorites.map(item => {
      const questionId = resolveOldQuestionId(item.qid);
      if (!questionId) return null;
      return {
        user_id: state.user.id,
        question_id: questionId,
        question_source: 'personal',
        fav_time: new Date(item.favTime || Date.now()).toISOString()
      };
    }).filter(Boolean);

    if (migratedWrongRows.length) {
      const { error } = await state.client.from('wrong_records').upsert(migratedWrongRows, { onConflict: 'user_id,question_id' });
      if (error) throw error;
    }
    if (migratedFavoriteRows.length) {
      const { error } = await state.client.from('favorite_records').upsert(migratedFavoriteRows, { onConflict: 'user_id,question_id' });
      if (error) throw error;
    }
    showToast(`旧版数据迁移完成：${uniqueQuestions.length} 道题库、${migratedWrongRows.length} 道错题、${migratedFavoriteRows.length} 道收藏。`, 'success');
    return { personalRows: latestPersonalRows, wrongRows: migratedWrongRows, favoriteRows: migratedFavoriteRows };
  }

  async function migrateLegacyProgress(mergedQuestions) {
    const migrationKey = `progress_migration_v2_${state.user.id}`;
    if (localStorage.getItem(migrationKey) === 'done') return;
    const [legacySessions, legacyAnswers] = await Promise.all([
      fetchAll('practice_sessions', 'id,user_id,mode,label,started_at,completed_at,duration_seconds,total_questions,total_subquestions,answered_count,correct_count,accuracy,metadata', 'completed_at', false),
      fetchAll('answer_history', 'id,session_id,user_id,question_id,sub_index,user_answer,correct_answer,is_answered,is_correct,question_snapshot,answered_at', 'id', true)
    ]);
    if (legacySessions.length === 0 && legacyAnswers.length === 0) {
      localStorage.setItem(migrationKey, 'done');
      return;
    }

    const mergedById = new Map();
    mergedQuestions.forEach(question => (question.allIds || [question.id]).forEach(id => mergedById.set(String(id), question)));
    const latestByUnit = new Map();
    for (const answer of [...legacyAnswers].sort((a, b) => new Date(b.answered_at) - new Date(a.answered_at))) {
      const question = mergedById.get(String(answer.question_id));
      if (!question) continue;
      const key = `${question.fingerprint}:${answer.sub_index}`;
      if (!latestByUnit.has(key)) latestByUnit.set(key, { answer, question });
    }
    const currentStateMap = new Map((state.learningStates || []).map(row => [`${row.question_fingerprint}:${row.sub_index}`, row]));
    const stateRows = [...latestByUnit.values()].map(({ answer, question }) => ({
      user_id: state.user.id,
      question_fingerprint: question.fingerprint,
      sub_index: answer.sub_index,
      question_id: String(question.id),
      sources: question.sources || [question.source || 'personal'],
      question_snapshot: window.QuizProgressCore.questionContent(question),
      chapter: window.QuizProgressCore.normalizeChapter(question.knowledge),
      latest_answer: answer.user_answer || [],
      is_correct: Boolean(answer.is_correct),
      answered_at: answer.answered_at
    })).filter(row => {
      const current = currentStateMap.get(`${row.question_fingerprint}:${row.sub_index}`);
      return !current || new Date(row.answered_at).getTime() > new Date(current.answered_at || 0).getTime();
    });
    for (let start = 0; start < stateRows.length; start += 100) {
      const { error } = await state.client.from('user_learning_states').upsert(stateRows.slice(start, start + 100), { onConflict: 'user_id,question_fingerprint,sub_index' });
      if (error) throw error;
    }

    for (const session of legacySessions.filter(item => item.mode === 'mock' || item.mode === 'random')) {
      const sessionAnswers = legacyAnswers.filter(answer => answer.session_id === session.id);
      const groups = new Map();
      sessionAnswers.forEach(answer => {
        if (!groups.has(answer.question_id)) groups.set(answer.question_id, []);
        groups.get(answer.question_id).push(answer);
      });
      const orderedGroups = [...groups.entries()].sort((a, b) => Math.min(...a[1].map(row => Number(row.id))) - Math.min(...b[1].map(row => Number(row.id))));
      const detailRows = [];
      for (let index = 0; index < orderedGroups.length; index++) {
        const [questionId, rows] = orderedGroups[index];
        const question = mergedById.get(String(questionId));
        const firstSnapshot = rows[0]?.question_snapshot || {};
        const snapshot = question ? window.QuizProgressCore.questionContent(question) : (firstSnapshot.parent || firstSnapshot);
        const fingerprint = question?.fingerprint || await window.QuizProgressCore.fingerprintQuestion(snapshot);
        const answers = rows.slice().sort((a, b) => a.sub_index - b.sub_index).map(row => ({
          subIndex: row.sub_index,
          isAnswered: Boolean(row.is_answered),
          isCorrect: Boolean(row.is_correct),
          userAnswer: row.user_answer || [],
          correctAnswer: row.correct_answer || []
        }));
        const status = window.QuizProgressCore.getTopLevelQuestionStatus(snapshot, answers.map(item => item));
        detailRows.push({
          session_id: session.id,
          user_id: state.user.id,
          question_order: index + 1,
          question_fingerprint: fingerprint,
          question_snapshot: firstSnapshot,
          chapter: window.QuizProgressCore.normalizeChapter(snapshot.knowledge),
          sources: question?.sources || [firstSnapshot.source || 'public'],
          answers,
          status
        });
      }
      const { error: sessionError } = await state.client.from('study_sessions').upsert({
        id: session.id,
        user_id: state.user.id,
        mode: session.mode,
        status: 'completed',
        started_at: session.started_at,
        ended_at: session.completed_at,
        planned_questions: session.total_questions,
        planned_subquestions: session.total_subquestions,
        answered_count: session.answered_count,
        correct_count: session.correct_count,
        accuracy: session.accuracy,
        duration_seconds: session.duration_seconds,
        metadata: session.metadata || {},
        updated_at: new Date().toISOString()
      }, { onConflict: 'id' });
      if (sessionError) throw sessionError;
      const { error: cleanupError } = await state.client.from('study_session_questions').delete().eq('session_id', session.id).eq('user_id', state.user.id);
      if (cleanupError) throw cleanupError;
      if (detailRows.length) {
        const { error: detailsError } = await state.client.from('study_session_questions').insert(detailRows);
        if (detailsError) throw detailsError;
      }
    }

    if (stateRows.length || legacySessions.some(item => item.mode === 'mock' || item.mode === 'random')) {
      learningStates = await fetchAll('user_learning_states', 'user_id,question_fingerprint,sub_index,question_id,sources,question_snapshot,chapter,latest_answer,is_correct,answered_at,updated_at', 'answered_at', false);
      state.learningStates = learningStates;
      state.learningRevision++;
      showToast(`旧学习数据迁移完成：${stateRows.length} 个小问、${legacySessions.filter(item => item.mode === 'mock' || item.mode === 'random').length} 次测验。`, 'success');
    }
    localStorage.setItem(migrationKey, 'done');
  }

  async function enterApp() {
    $('authSubmitBtn').disabled = true;
    setAuthNotice('正在同步你的题库和学习记录...');
    state.suppressSync = true;
    const localSnapshot = {
      questions: loadUserQuestions().filter(question => question.source !== 'public'),
      wrong: Array.isArray(wrongList) ? JSON.parse(JSON.stringify(wrongList)) : [],
      favorites: Array.isArray(favoritesList) ? JSON.parse(JSON.stringify(favoritesList)) : []
    };
    let [personalRows, publicRows, wrongRows, favoriteRows] = await Promise.all([
      fetchAll('personal_questions', 'id,question_key,payload,created_at,updated_at'),
      fetchAll('global_questions', 'id,question_key,payload,created_at,updated_at'),
      fetchAll('wrong_records', 'question_id,question_source,wrong_count,last_user_choice_texts,last_sub_choice_texts,last_time', 'last_time', false),
      fetchAll('favorite_records', 'question_id,question_source,fav_time', 'fav_time', false)
    ]);
    const migration = await migrateLegacyLocalData(localSnapshot, personalRows, wrongRows, favoriteRows);
    if (migration) {
      personalRows = migration.personalRows;
      wrongRows = migration.wrongRows;
      favoriteRows = migration.favoriteRows;
    }

    const personal = personalRows.map(row => rowToQuestion(row, 'personal'));
    const publicBank = publicRows.map(row => rowToQuestion(row, 'public'));
    const merged = await window.QuizProgressCore.mergeQuestions([...personal, ...publicBank]);
    const findQuestionById = qid => merged.find(question => (question.allIds || [question.id]).map(String).includes(String(qid)));
    saveUserQuestions(personal);
    savePublicQuestions(publicBank);
    saveMergedQuestions(merged);

    const mappedWrong = wrongRows.map(row => {
      const question = findQuestionById(row.question_id);
      if (!question) return null;
      return {
        qid: String(question.id),
        wrongCount: Number(row.wrong_count) || 1,
        lastTime: new Date(row.last_time).getTime(),
        lastUserChoiceTexts: row.last_user_choice_texts || undefined,
        lastSubChoiceTexts: row.last_sub_choice_texts || undefined
      };
    }).filter(Boolean);
    wrongList = [...new Map(mappedWrong.map(item => [item.qid, item])).values()];
    favoritesList = [...new Map(favoriteRows.map(row => {
      const question = findQuestionById(row.question_id);
      return question ? [String(question.id), { qid: String(question.id), favTime: new Date(row.fav_time).getTime() }] : null;
    }).filter(Boolean)).values()];
    localStorage.setItem('wrongList_tax_v22', JSON.stringify(wrongList));
    localStorage.setItem('favorites_tax_v22', JSON.stringify(favoritesList));
    state.serverWrongIds = new Set(wrongList.map(item => String(item.qid)));
    state.serverFavoriteIds = new Set(favoritesList.map(item => String(item.qid)));

    const [learningRows, activeResult] = await Promise.all([
      fetchAll('user_learning_states', 'user_id,question_fingerprint,sub_index,question_id,sources,question_snapshot,chapter,latest_answer,is_correct,answered_at,updated_at', 'answered_at', false),
      state.client.from('active_practices').select('mode,payload,started_at,updated_at').eq('user_id', state.user.id).maybeSingle()
    ]);
    if (activeResult.error) throw activeResult.error;
    learningStates = learningRows || [];
    state.learningStates = learningStates;
    const expandedActive = activeResult.data ? expandActivePayload(activeResult.data.payload, merged) : null;
    state.activePractice = expandedActive
      ? { mode: activeResult.data.mode, payload: expandedActive, updated_at: activeResult.data.updated_at }
      : null;
    await flushPendingLearningStates();
    learningStates = await fetchAll('user_learning_states', 'user_id,question_fingerprint,sub_index,question_id,sources,question_snapshot,chapter,latest_answer,is_correct,answered_at,updated_at', 'answered_at', false);
    state.learningStates = learningStates;
    let localActive = null;
    try { localActive = JSON.parse(localStorage.getItem('active_practice_tax_v23') || 'null'); } catch (_) { localActive = null; }
    if (localActive?.userId === state.user.id && localActive.pendingSync === true) {
      const localSavedAt = Number(localActive.savedAt) || 0;
      const remoteSavedAt = state.activePractice?.updated_at ? new Date(state.activePractice.updated_at).getTime() : 0;
      if (!state.activePractice || localSavedAt > remoteSavedAt) {
        state.activePractice = { mode: localActive.mode, payload: localActive };
      }
    }
    await migrateLegacyProgress(merged);

    updateRoleUi();
    if (!state.appStarted) {
      startQuizApp(state.activePractice?.payload || null);
      state.appStarted = true;
    } else {
      rebuildMasterList();
    }
    state.suppressSync = false;
    $('authScreen').classList.add('hidden');
    $('appShell').classList.remove('hidden');
    setAuthNotice('');
    showToast(`已登录：${state.profile.display_name || state.profile.email}`, 'success');
  }

  function questionHash(question) {
    const content = `${question.type === 'comprehensive' ? 'comprehensive' : 'single'}\u0000${String(question.text || '').trim()}`;
    let hash = 1469598103934665603n;
    for (let i = 0; i < content.length; i++) {
      hash ^= BigInt(content.charCodeAt(i));
      hash = BigInt.asUintN(64, hash * 1099511628211n);
    }
    return hash.toString(16).padStart(16, '0');
  }

  function cleanQuestionPayload(question) {
    const copy = JSON.parse(JSON.stringify(question));
    delete copy.id;
    delete copy.source;
    delete copy.questionKey;
    delete copy.cloudUpdatedAt;
    return copy;
  }

  async function uploadQuestions(questions, scope = 'personal') {
    if (!state.client || !state.user || state.profile?.status !== 'active') throw new Error('登录状态已失效');
    if (scope === 'public' && state.profile?.role !== 'super_admin') throw new Error('只有超级管理员可以上传公共题库');
    const table = scope === 'public' ? 'global_questions' : 'personal_questions';
    const questionRows = await Promise.all(questions.map(async question => ({
      ...(scope === 'public' ? { uploaded_by: state.user.id } : { owner_id: state.user.id }),
      question_key: await window.QuizProgressCore.fingerprintQuestion(question),
      payload: cleanQuestionPayload(question)
    })));
    let inserted = 0;
    for (let start = 0; start < questionRows.length; start += 80) {
      const chunk = questionRows.slice(start, start + 80);
      const keys = chunk.map(row => row.question_key);
      let existingQuery = state.client.from(table).select('question_key').in('question_key', keys);
      if (scope !== 'public') existingQuery = existingQuery.eq('owner_id', state.user.id);
      const { data: existing, error: existingError } = await existingQuery;
      if (existingError) throw existingError;
      const existingKeys = new Set((existing || []).map(row => row.question_key));
      const freshRows = chunk.filter(row => !existingKeys.has(row.question_key));
      if (freshRows.length === 0) continue;
      const { data, error } = await state.client.from(table).insert(freshRows).select('id');
      if (error) throw error;
      inserted += (data || []).length;
    }
    return { inserted };
  }

  async function refreshQuestions() {
    if (!state.client || !state.user) throw new Error('登录状态已失效');
    const [personalRows, publicRows] = await Promise.all([
      fetchAll('personal_questions', 'id,question_key,payload,created_at,updated_at'),
      fetchAll('global_questions', 'id,question_key,payload,created_at,updated_at')
    ]);
    const personal = personalRows.map(row => rowToQuestion(row, 'personal'));
    const publicBank = publicRows.map(row => rowToQuestion(row, 'public'));
    const merged = await window.QuizProgressCore.mergeQuestions([...personal, ...publicBank]);
    saveUserQuestions(personal);
    savePublicQuestions(publicBank);
    saveMergedQuestions(merged);
    rebuildMasterList();
    updatePracticeInfo();
    return { personal: personal.length, public: publicBank.length, merged: merged.length };
  }

  function getQuestionMap() {
    return new Map((globalMasterList || []).map(question => [String(question.id), question]));
  }

  function scheduleWrongSync() {
    if (state.suppressSync || !state.user) return;
    clearTimeout(state.wrongTimer);
    state.wrongTimer = setTimeout(syncWrongRecords, 350);
  }

  function scheduleFavoriteSync() {
    if (state.suppressSync || !state.user) return;
    clearTimeout(state.favoriteTimer);
    state.favoriteTimer = setTimeout(syncFavoriteRecords, 350);
  }

  async function syncWrongRecords() {
    if (!state.client || !state.user || state.syncingWrong) return;
    state.syncingWrong = true;
    try {
      const questionMap = getQuestionMap();
      const current = wrongList.filter(item => questionMap.has(String(item.qid)));
      const currentIds = new Set(current.map(item => String(item.qid)));
      const removedIds = [...state.serverWrongIds].filter(id => !currentIds.has(id));
      if (removedIds.length) {
        const { error } = await state.client.from('wrong_records').delete().eq('user_id', state.user.id).in('question_id', removedIds);
        if (error) throw error;
      }
      const rows = current.map(item => {
        const question = questionMap.get(String(item.qid));
        return {
          user_id: state.user.id,
          question_id: String(item.qid),
          question_source: (question.sources || [question.source]).includes('public') ? 'public' : 'personal',
          wrong_count: Math.max(1, Number(item.wrongCount) || 1),
          last_user_choice_texts: item.lastUserChoiceTexts || null,
          last_sub_choice_texts: item.lastSubChoiceTexts || null,
          last_time: new Date(item.lastTime || Date.now()).toISOString(),
          updated_at: new Date().toISOString()
        };
      });
      for (let start = 0; start < rows.length; start += 150) {
        const { error } = await state.client.from('wrong_records').upsert(rows.slice(start, start + 150), { onConflict: 'user_id,question_id' });
        if (error) throw error;
      }
      state.serverWrongIds = currentIds;
    } catch (error) {
      console.error('错题同步失败', error);
      showToast(`错题同步失败：${error.message || error}`, 'error');
    } finally {
      state.syncingWrong = false;
    }
  }

  async function syncFavoriteRecords() {
    if (!state.client || !state.user || state.syncingFavorites) return;
    state.syncingFavorites = true;
    try {
      const questionMap = getQuestionMap();
      const current = favoritesList.filter(item => questionMap.has(String(item.qid)));
      const currentIds = new Set(current.map(item => String(item.qid)));
      const removedIds = [...state.serverFavoriteIds].filter(id => !currentIds.has(id));
      if (removedIds.length) {
        const { error } = await state.client.from('favorite_records').delete().eq('user_id', state.user.id).in('question_id', removedIds);
        if (error) throw error;
      }
      const rows = current.map(item => {
        const question = questionMap.get(String(item.qid));
        return {
          user_id: state.user.id,
          question_id: String(item.qid),
          question_source: (question.sources || [question.source]).includes('public') ? 'public' : 'personal',
          fav_time: new Date(item.favTime || Date.now()).toISOString(),
          updated_at: new Date().toISOString()
        };
      });
      for (let start = 0; start < rows.length; start += 150) {
        const { error } = await state.client.from('favorite_records').upsert(rows.slice(start, start + 150), { onConflict: 'user_id,question_id' });
        if (error) throw error;
      }
      state.serverFavoriteIds = currentIds;
    } catch (error) {
      console.error('收藏同步失败', error);
      showToast(`收藏同步失败：${error.message || error}`, 'error');
    } finally {
      state.syncingFavorites = false;
    }
  }

  async function resetPersonalData() {
    if (!state.client || !state.user) throw new Error('登录状态已失效');
    const userId = state.user.id;
    let result = await state.client.from('wrong_records').delete().eq('user_id', userId);
    if (result.error) throw result.error;
    result = await state.client.from('favorite_records').delete().eq('user_id', userId);
    if (result.error) throw result.error;
    result = await state.client.from('personal_questions').delete().eq('owner_id', userId);
    if (result.error) throw result.error;
    state.serverWrongIds = new Set();
    state.serverFavoriteIds = new Set();
  }

  async function resetPublicBank() {
    if (state.profile?.role !== 'super_admin') throw new Error('只有超级管理员可以清空公共题库');
    if (!confirm('⚠️ 将清空所有用户可见的公共题库，但不会删除用户自己的题库和已有答题历史。确定继续？')) return;
    const { error } = await state.client.from('global_questions').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    if (error) throw error;
    await refreshQuestions();
    startNormalPractice();
    document.getElementById('uploadFeedback').textContent = '公共题库已清空。';
  }

  function normalizeLetters(value) {
    if (value == null) return [];
    const values = Array.isArray(value) ? value : [value];
    return [...new Set(values.filter(Boolean).map(letter => String(letter).toUpperCase()))].sort();
  }

  function captureActivePractice() {
    if (!currentSession) return null;
    return {
      version: 2,
      userId: state.user?.id,
      mode: currentMode,
      session: JSON.parse(JSON.stringify(currentSession)),
      filters: { year: currentFilterYear, type: currentFilterType, chapter: currentFilterChapter },
      questions: JSON.parse(JSON.stringify(currentPracticeSet)),
      currentIndex: currentPracticeIndex,
      answers: JSON.parse(JSON.stringify(userAnswers)),
      submittedFlags: JSON.parse(JSON.stringify(submittedFlags)),
      mock: currentMode === 'mock' ? { ...mockState, timerId: null } : null,
      savedAt: Date.now(),
      pendingSync: state.activeDirty
    };
  }

  function compactActivePayload(payload) {
    if (!payload) return null;
    return {
      version: 3,
      userId: payload.userId,
      mode: payload.mode,
      session: payload.session,
      filters: payload.filters,
      currentIndex: payload.currentIndex,
      answers: payload.answers,
      submittedFlags: payload.submittedFlags,
      mock: payload.mock,
      savedAt: payload.savedAt,
      pendingSync: payload.pendingSync,
      questionRefs: (payload.questions || []).map(question => ({
        fingerprint: question.fingerprint,
        shuffle: isComprehensive(question)
          ? question.subQuestions.map(subQuestion => subQuestion.letterMap || {})
          : (question.letterMap || {})
      }))
    };
  }

  function expandActivePayload(payload, sourceQuestions = globalMasterList) {
    if (!payload) return null;
    if (payload.version === 2 && Array.isArray(payload.questions)) return payload;
    const byFingerprint = new Map((sourceQuestions || []).map(question => [question.fingerprint, question]));
    const questions = (payload.questionRefs || []).map(ref => {
      const original = byFingerprint.get(ref.fingerprint);
      return original ? applyStoredShuffle(original, ref.shuffle) : null;
    });
    if (questions.some(question => !question)) return null;
    return { ...payload, version: 2, questions };
  }

  function summarizePractice(payload) {
    let plannedSubquestions = 0;
    let answered = 0;
    let correct = 0;
    (payload.questions || []).forEach((question, index) => {
      const flags = payload.submittedFlags?.[index];
      const answers = payload.answers?.[index];
      if (isComprehensive(question)) {
        plannedSubquestions += question.subQuestions.length;
        question.subQuestions.forEach((subQuestion, subIndex) => {
          if (!flags?.[subIndex]) return;
          answered++;
          const selected = normalizeLetters(answers?.[subIndex]);
          if (selected.join('') === normalizeLetters(subQuestion.correctLetter).join('')) correct++;
        });
      } else {
        plannedSubquestions++;
        if (!flags) return;
        answered++;
        if (normalizeLetters(answers).join('') === normalizeLetters(question.correctLetter).join('')) correct++;
      }
    });
    const endedAt = Number(payload.session?.finishedAt || Date.now());
    const durationSeconds = Math.max(0, Math.round((endedAt - Number(payload.session?.startedAt || endedAt)) / 1000));
    return {
      planned_questions: (payload.questions || []).length,
      planned_subquestions: plannedSubquestions,
      answered_count: answered,
      correct_count: correct,
      accuracy: answered ? Number((correct / answered * 100).toFixed(2)) : 0,
      duration_seconds: durationSeconds
    };
  }

  function questionSessionRow(question, index, payload = captureActivePractice()) {
    const answerValues = payload?.answers?.[index];
    const submitted = payload?.submittedFlags?.[index];
    const answers = isComprehensive(question)
      ? question.subQuestions.map((subQuestion, subIndex) => ({
          subIndex: subIndex + 1,
          isAnswered: Boolean(submitted?.[subIndex]),
          isCorrect: Boolean(submitted?.[subIndex] && normalizeLetters(answerValues?.[subIndex]).join('') === normalizeLetters(subQuestion.correctLetter).join('')),
          userAnswer: submitted?.[subIndex] ? normalizeLetters(answerValues?.[subIndex]) : [],
          correctAnswer: normalizeLetters(subQuestion.correctLetter)
        }))
      : [{
          subIndex: 0,
          isAnswered: Boolean(submitted),
          isCorrect: Boolean(submitted && normalizeLetters(answerValues).join('') === normalizeLetters(question.correctLetter).join('')),
          userAnswer: submitted ? normalizeLetters(answerValues) : [],
          correctAnswer: normalizeLetters(question.correctLetter)
        }];
    return {
      session_id: payload.session.id,
      user_id: state.user.id,
      question_order: index + 1,
      question_fingerprint: question.fingerprint,
      question_snapshot: JSON.parse(JSON.stringify(question)),
      chapter: window.QuizProgressCore.normalizeChapter(question.knowledge),
      sources: question.sources || [question.source || 'personal'],
      answers,
      status: window.QuizProgressCore.getTopLevelQuestionStatus(question, answers),
      updated_at: new Date().toISOString()
    };
  }

  function assessmentSessionRow(payload, status = 'in_progress') {
    const summary = summarizePractice(payload);
    return {
      id: payload.session.id,
      user_id: state.user.id,
      mode: payload.session.mode === 'mock' ? 'mock' : 'random',
      status,
      started_at: new Date(payload.session.startedAt).toISOString(),
      ended_at: status === 'in_progress' ? null : new Date().toISOString(),
      ...summary,
      metadata: { filters: payload.filters, mock_duration_minutes: payload.mock?.durationMin || null },
      updated_at: new Date().toISOString()
    };
  }

  async function createAssessmentQuestions(payload) {
    const rows = (payload.questions || []).map((question, index) => questionSessionRow(question, index, payload));
    for (let start = 0; start < rows.length; start += 100) {
      const { error } = await state.client.from('study_session_questions').upsert(rows.slice(start, start + 100), { onConflict: 'session_id,question_order' });
      if (error) throw error;
    }
  }

  async function saveAssessmentSummary(payload, status) {
    if (!['mock', 'random'].includes(payload.mode)) return;
    const { error } = await state.client.from('study_sessions').upsert(assessmentSessionRow(payload, status), { onConflict: 'id' });
    if (error) throw error;
  }

  async function saveAssessmentSession(payload, status) {
    await saveAssessmentSummary(payload, status);
    await createAssessmentQuestions(payload);
  }

  async function archivePreviousPractice(previous, newSessionId) {
    if (!previous?.payload?.session || previous.payload.session.id === newSessionId) return;
    if (['mock', 'random'].includes(previous.mode)) await saveAssessmentSession(previous.payload, 'incomplete');
  }

  async function startActivePractice() {
    if (!state.client || !state.user || !currentSession) return false;
    state.activeDirty = true;
    const payload = captureActivePractice();
    try {
      await archivePreviousPractice(state.activePractice, payload.session.id);
      state.activePractice = { mode: payload.mode, payload };
      localStorage.setItem('active_practice_tax_v23', JSON.stringify(payload));
      if (['mock', 'random'].includes(payload.mode)) await saveAssessmentSession(payload, 'in_progress');
      await flushActivePractice();
      return true;
    } catch (error) {
      console.error('开始练习保存失败', error);
      showToast(`练习进度尚未同步：${error.message || error}`, 'error');
      return false;
    }
  }

  function scheduleActivePracticeSave(immediate = false) {
    if (state.suppressSync || !state.user || !currentSession) return;
    state.activeDirty = true;
    const payload = captureActivePractice();
    if (payload) {
      payload.pendingSync = true;
      state.activePractice = { mode: payload.mode, payload };
      localStorage.setItem('active_practice_tax_v23', JSON.stringify(payload));
    }
    clearTimeout(state.activeSaveTimer);
    if (immediate) queueMicrotask(flushActivePractice);
    else state.activeSaveTimer = setTimeout(() => flushActivePractice(), 400);
  }

  async function flushActivePractice() {
    if (!state.client || !state.user || !currentSession || !state.activeDirty) return;
    if (state.activeSavePromise) {
      state.activeDirty = true;
      return state.activeSavePromise.then(() => state.activeDirty ? flushActivePractice() : undefined);
    }
    state.activeSavePromise = (async () => {
      while (state.activeDirty) {
        state.activeDirty = false;
        const payload = captureActivePractice();
        if (!payload) break;
        payload.pendingSync = true;
        state.activePractice = { mode: payload.mode, payload };
        localStorage.setItem('active_practice_tax_v23', JSON.stringify(payload));
        const remotePayload = compactActivePayload(payload);
        const { error } = await state.client.from('active_practices').upsert({
          user_id: state.user.id,
          mode: payload.mode,
          payload: remotePayload,
          started_at: new Date(payload.session.startedAt).toISOString(),
          updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' });
        if (error) { state.activeDirty = true; throw error; }
        if (!state.activeDirty) {
          payload.pendingSync = false;
          state.activePractice = { mode: payload.mode, payload };
          localStorage.setItem('active_practice_tax_v23', JSON.stringify(payload));
        }
      }
    })().catch(error => {
      console.error('当前练习同步失败', error);
      showToast(`当前练习尚未同步：${error.message || error}`, 'error');
    }).finally(() => { state.activeSavePromise = null; });
    return state.activeSavePromise;
  }

  async function waitForActiveSave() {
    if (state.activeSavePromise) await state.activeSavePromise;
    if (state.activeDirty) await flushActivePractice();
  }

  function queueLearningState(row) {
    try {
      const queue = JSON.parse(localStorage.getItem('pending_learning_states_v1') || '[]');
      const key = `${row.question_fingerprint}:${row.sub_index}`;
      const next = queue.filter(item => `${item.question_fingerprint}:${item.sub_index}` !== key);
      next.push(row);
      localStorage.setItem('pending_learning_states_v1', JSON.stringify(next));
    } catch (_) { /* 本地队列失败时仍保留页面内状态 */ }
  }

  async function flushPendingLearningStates() {
    if (!state.client || !state.user) return;
    let queue = [];
    try { queue = JSON.parse(localStorage.getItem('pending_learning_states_v1') || '[]'); } catch (_) { queue = []; }
    if (!queue.length) return;
    const remaining = [];
    for (const row of queue) {
      if (row.user_id !== state.user.id) continue;
      const { error } = await state.client.from('user_learning_states').upsert(row, { onConflict: 'user_id,question_fingerprint,sub_index' });
      if (error) remaining.push(row);
    }
    localStorage.setItem('pending_learning_states_v1', JSON.stringify(remaining));
  }

  async function recordSubmittedAnswer({ question, questionIndex, subIndex, answer, isCorrect }) {
    if (!state.client || !state.user || !question?.fingerprint) return false;
    const answeredAt = new Date().toISOString();
    const row = {
      user_id: state.user.id,
      question_fingerprint: question.fingerprint,
      sub_index: subIndex,
      question_id: String(question.id),
      sources: question.sources || [question.source || 'personal'],
      question_snapshot: JSON.parse(JSON.stringify(question)),
      chapter: window.QuizProgressCore.normalizeChapter(question.knowledge),
      latest_answer: normalizeLetters(answer),
      is_correct: Boolean(isCorrect),
      answered_at: answeredAt,
      updated_at: answeredAt
    };
    const key = `${row.question_fingerprint}:${row.sub_index}`;
    state.learningRevision++;
    const existingIndex = learningStates.findIndex(item => `${item.question_fingerprint}:${item.sub_index}` === key);
    if (existingIndex >= 0) learningStates[existingIndex] = row; else learningStates.push(row);
    state.learningStates = learningStates;
    updatePracticeInfo();
    queueLearningState(row);
    try {
      const { error } = await state.client.from('user_learning_states').upsert(row, { onConflict: 'user_id,question_fingerprint,sub_index' });
      if (error) throw error;
      const queue = JSON.parse(localStorage.getItem('pending_learning_states_v1') || '[]');
      localStorage.setItem('pending_learning_states_v1', JSON.stringify(queue.filter(item => `${item.question_fingerprint}:${item.sub_index}` !== key)));
    } catch (error) {
      console.error('学习状态同步失败', error);
      showToast(`本题已记录在本机，云端同步稍后重试：${error.message || error}`, 'error');
    }
    if (['mock', 'random'].includes(currentMode) && currentSession) {
      try {
        const payload = captureActivePractice();
        const detail = questionSessionRow(question, questionIndex, payload);
        const { error } = await state.client.from('study_session_questions').upsert(detail, { onConflict: 'session_id,question_order' });
        if (error) throw error;
        await saveAssessmentSummary(payload, 'in_progress');
      } catch (error) {
        console.error('测验明细同步失败', error);
        showToast(`测验明细尚未同步：${error.message || error}`, 'error');
      }
    }
    scheduleActivePracticeSave();
    return true;
  }

  async function archiveActivePractice() {
    if (!currentSession || currentSession.finalizing) return false;
    const payload = captureActivePractice();
    state.activePractice = { mode: payload.mode, payload };
    try {
      if (['mock', 'random'].includes(payload.mode)) await saveAssessmentSession(payload, 'incomplete');
      return true;
    } catch (error) {
      console.error('旧练习归档失败', error);
      showToast(`旧练习归档失败：${error.message || error}`, 'error');
      return false;
    }
  }

  async function finalizeCurrentPractice(status = 'completed') {
    if (!state.client || !state.user || !currentSession || currentSession.finalizing) return false;
    const finishingSession = currentSession;
    finishingSession.finalizing = true;
    const payload = captureActivePractice();
    payload.session.finishedAt = Date.now();
    try {
      if (state.activeSavePromise) await state.activeSavePromise;
      if (['mock', 'random'].includes(payload.mode)) await saveAssessmentSession(payload, status);
      if (currentSession?.id === finishingSession.id) {
        const { error } = await state.client.from('active_practices').delete().eq('user_id', state.user.id);
        if (error) throw error;
        state.activePractice = null;
        localStorage.removeItem('active_practice_tax_v23');
      }
      finishingSession.finished = true;
      return true;
    } catch (error) {
      console.error('练习结束状态保存失败', error);
      showToast(`练习状态保存失败：${error.message || error}`, 'error');
      return false;
    } finally {
      finishingSession.finalizing = false;
    }
  }

  async function clearActivePractice() {
    state.activePractice = null;
    state.activeDirty = false;
    localStorage.removeItem('active_practice_tax_v23');
    if (state.client && state.user) await state.client.from('active_practices').delete().eq('user_id', state.user.id);
  }

  function historyModeLabel(mode) {
    return ({
      practice: '题库练习',
      random: '临考押题',
      mock: '模拟测验',
      wrong_practice: '错题练习',
      favorite_practice: '收藏题练习',
      list_practice: '专项练习'
    })[mode] || mode || '练习';
  }

  function formatDuration(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const minutes = Math.floor(total / 60);
    const remain = total % 60;
    return minutes ? `${minutes}分${remain}秒` : `${remain}秒`;
  }

  function latestLearningStates(remoteRows) {
    let pendingRows = [];
    try { pendingRows = JSON.parse(localStorage.getItem('pending_learning_states_v1') || '[]'); } catch (_) { pendingRows = []; }
    const rows = new Map((pendingRows || []).filter(row => row.user_id === state.user.id).map(row => [`${row.question_fingerprint}:${row.sub_index}`, row]));
    for (const row of remoteRows || []) {
      const key = `${row.question_fingerprint}:${row.sub_index}`;
      const current = rows.get(key);
      if (!current || new Date(row.answered_at).getTime() >= new Date(current.answered_at || 0).getTime()) rows.set(key, row);
    }
    return [...rows.values()];
  }

  function renderChapterStats() {
    const container = document.getElementById('chapterStatsList');
    if (!container) return;
    const stats = window.QuizProgressCore.computeChapterStats(globalMasterList, learningStates);
    const chapters = Object.entries(stats).sort((a, b) => {
      const order = values => {
        const match = values[0].match(/第([一二三四五六七八九十百]+)章/);
        const numbers = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20 };
        return match ? (numbers[match[1]] || 999) : 999;
      };
      return order(a) - order(b) || a[0].localeCompare(b[0], 'zh-CN');
    });
    if (!chapters.length) { container.innerHTML = '<div class="empty-tip">当前题库还没有章节数据</div>'; return; }
    container.innerHTML = chapters.map(([chapter, item]) => `<div class="chapter-stat-row">
      <div class="chapter-stat-name">${cloudEscape(chapter)}</div>
      <div class="chapter-stat-cell"><strong>${item.done}/${item.total}</strong>已做/总题</div>
      <div class="chapter-stat-cell"><strong>${item.undone}</strong>未做</div>
      <div class="chapter-stat-cell"><strong>${item.correct}</strong>答对</div>
      <div class="chapter-stat-cell"><strong>${item.wrong}</strong>答错</div>
      <div class="chapter-stat-cell"><strong>${item.accuracy.toFixed(1)}%</strong>正确率</div>
      <button class="btn btn-danger" data-reset-chapter="${cloudEscape(chapter)}">重置本章</button>
    </div>`).join('');
  }

  function sessionStatusLabel(status) {
    return ({ in_progress: '进行中', incomplete: '未完成', completed: '已完成' })[status] || status;
  }

  function sessionCardHtml(session) {
    const expanded = state.historyExpanded.has(String(session.id));
    const isActive = currentSession?.id === String(session.id) && session.status === 'in_progress';
    const time = session.ended_at || session.started_at;
    return `<div class="history-card ${expanded ? 'expanded' : ''}" data-session-id="${cloudEscape(session.id)}">
      <div class="history-card-head">
        <div><div class="history-mode">${cloudEscape(historyModeLabel(session.mode))}</div><div class="history-time">${new Date(time).toLocaleString()} · ${cloudEscape(sessionStatusLabel(session.status))}</div>${isActive ? '' : `<button type="button" class="history-delete-btn" data-delete-session="${cloudEscape(session.id)}" style="margin-top:6px;">删除记录</button>`}</div>
        <div class="history-stat"><strong>${Number(session.accuracy || 0).toFixed(1)}%</strong>正确率</div>
        <div class="history-stat"><strong>${session.answered_count}/${session.planned_subquestions}</strong>已作答</div>
        <div class="history-stat"><strong>${session.correct_count}</strong>答对</div>
        <div class="history-stat"><strong>${formatDuration(session.duration_seconds)}</strong>用时</div>
        <div class="history-chevron">▶</div>
      </div>
      <div class="history-detail ${expanded ? '' : 'hidden'}">${expanded ? '<div class="cloud-status">正在读取题目...</div>' : ''}</div>
    </div>`;
  }

  function renderSessionLists(sessions) {
    const groups = { mock: [], random: [] };
    sessions.forEach(session => { if (groups[session.mode]) groups[session.mode].push(session); });
    for (const [mode, listId] of [['mock', 'mockHistoryList'], ['random', 'randomHistoryList']]) {
      const target = document.getElementById(listId);
      if (!target) continue;
      target.innerHTML = groups[mode].length ? groups[mode].map(sessionCardHtml).join('') : `<div class="empty-tip">暂无${mode === 'mock' ? '模拟测验' : '临考押题'}记录</div>`;
    }
  }

  async function loadSessionQuestions(sessionId, detailEl) {
    detailEl.innerHTML = '<div class="cloud-status">正在读取题目...</div>';
    try {
      let rows = state.sessionQuestionCache.get(String(sessionId));
      if (!rows) {
        const { data, error } = await state.client.from('study_session_questions')
          .select('session_id,question_order,question_fingerprint,question_snapshot,chapter,sources,answers,status')
          .eq('session_id', sessionId).eq('user_id', state.user.id).order('question_order', { ascending: true });
        if (error) throw error;
        rows = data || [];
        state.sessionQuestionCache.set(String(sessionId), rows);
      }
      if (!rows.length) { detailEl.innerHTML = '<div class="empty-tip">本次没有可显示的题目</div>'; return; }
      const selectedOrder = state.selectedHistoryQuestion.get(String(sessionId));
      detailEl.innerHTML = `<div class="hint" style="margin-bottom:8px;">先选择题号，再查看该题作答情况。</div>
        <div class="question-number-grid">${rows.map(row => `<button type="button" class="question-number-btn ${cloudEscape(row.status)} ${selectedOrder === row.question_order ? 'selected' : ''}" data-question-order="${row.question_order}">${row.question_order}</button>`).join('')}</div>
        <div class="session-question-detail" data-question-detail>${selectedOrder ? '' : '请选择题号'}</div>`;
      if (selectedOrder) {
        const row = rows.find(item => Number(item.question_order) === Number(selectedOrder));
        if (row) detailEl.querySelector('[data-question-detail]').innerHTML = buildSessionQuestionDetail(row);
      }
    } catch (error) {
      detailEl.innerHTML = `<div class="cloud-status" style="color:#b91c1c;">读取失败：${cloudEscape(error.message || error)}</div>`;
    }
  }

  function optionClass(answer, optionLetter) {
    const isCorrect = answer?.correctAnswer?.includes(optionLetter);
    const isSelected = answer?.userAnswer?.includes(optionLetter);
    if (isCorrect && isSelected) return 'session-option correct';
    if (isCorrect) return 'session-option correct';
    if (isSelected) return 'session-option wrong';
    return 'session-option';
  }

  function answerSummary(answer) {
    if (!answer?.isAnswered) return '未答';
    return answer.userAnswer?.join('') || '未答';
  }

  function buildSessionQuestionDetail(row) {
    const snapshotWrapper = row.question_snapshot || {};
    const question = snapshotWrapper.parent || snapshotWrapper;
    const sourceText = (row.sources || []).includes('public') && (row.sources || []).includes('personal') ? '公共题库＋我的题库' : ((row.sources || []).includes('public') ? '公共题库' : '我的题库');
    const answers = new Map((row.answers || []).map(answer => [Number(answer.subIndex), answer]));
    const header = `<div class="history-answer-meta" style="margin-bottom:8px;">${cloudEscape(sourceText)} · ${cloudEscape(row.chapter || '未分类')}</div>`;
    if (window.QuizProgressCore.isComprehensive(question)) {
      return header + `<div class="question-text comp-question-bg">${cloudEscape(question.text)}</div>` + question.subQuestions.map((sub, index) => {
        const answer = answers.get(index + 1) || { userAnswer: [], correctAnswer: [], isAnswered: false, isCorrect: false };
        const options = sub.options.map(option => `<div class="${optionClass(answer, option.letter)}">${option.letter}. ${cloudEscape(option.text)}</div>`).join('');
        return `<div class="sub-q-recite"><div style="font-weight:700;margin-bottom:6px;">第(${index + 1})小问</div><div class="question-text" style="font-size:1rem;">${cloudEscape(sub.text)}</div>${options}<div class="explanation"><strong>你的答案：${cloudEscape(answerSummary(answer))}</strong>　<strong>正确答案：${cloudEscape((answer.correctAnswer || []).join('') || '-')}</strong><br>${cloudEscape(remapExplanation(sub.explanation, sub.letterMap))}</div></div>`;
      }).join('');
    }
    const answer = answers.get(0) || { userAnswer: [], correctAnswer: [], isAnswered: false, isCorrect: false };
    const options = (question.options || []).map(option => `<div class="${optionClass(answer, option.letter)}">${option.letter}. ${cloudEscape(option.text)}</div>`).join('');
    return header + `<div class="question-text">${cloudEscape(question.text)}</div>${options}<div class="explanation"><strong>你的答案：${cloudEscape(answerSummary(answer))}</strong>　<strong>正确答案：${cloudEscape((answer.correctAnswer || []).join('') || '-')}</strong><br>${cloudEscape(remapExplanation(question.explanation, question.letterMap))}</div>`;
  }

  async function refreshHistory() {
    if (!state.client || !state.user || !state.profile) return;
    const summaryEl = document.getElementById('historySummary');
    if (summaryEl) summaryEl.textContent = '正在读取学习记录...';
    const learningRevision = state.learningRevision;
    try {
      const [remoteStates, sessions] = await Promise.all([
        fetchAll('user_learning_states', 'user_id,question_fingerprint,sub_index,question_id,sources,question_snapshot,chapter,latest_answer,is_correct,answered_at,updated_at', 'answered_at', false),
        fetchAll('study_sessions', 'id,mode,status,started_at,ended_at,planned_questions,planned_subquestions,answered_count,correct_count,accuracy,duration_seconds,updated_at', 'started_at', false)
      ]);
      if (state.learningRevision !== learningRevision) return;
      learningStates = latestLearningStates(remoteStates);
      state.learningStates = learningStates;
      renderChapterStats();
      renderSessionLists(sessions);
      updatePracticeInfo();
      const completed = sessions.filter(item => item.status === 'completed').length;
      if (summaryEl) summaryEl.textContent = `已同步 ${learningStates.length} 个学习小问 · ${sessions.length} 条测验记录，其中 ${completed} 条已完成`;
      for (const session of sessions) {
        if (!state.historyExpanded.has(String(session.id))) continue;
        const card = document.querySelector(`.history-card[data-session-id="${CSS.escape(String(session.id))}"]`);
        if (card) await loadSessionQuestions(session.id, card.querySelector('.history-detail'));
      }
    } catch (error) {
      if (summaryEl) summaryEl.textContent = `读取失败：${error.message || error}`;
      console.error(error);
    }
  }

  async function resetAllLearningStates() {
    if (!confirm('确定重置全部章节的累积答题记录？当前练习、模拟测验记录、临考押题记录、错题本和收藏都不会改变。')) return;
    const { error } = await state.client.from('user_learning_states').delete().eq('user_id', state.user.id);
    if (error) { showToast(`重置失败：${error.message}`, 'error'); return; }
    state.learningRevision++;
    learningStates = [];
    state.learningStates = [];
    localStorage.removeItem('pending_learning_states_v1');
    updatePracticeInfo();
    renderChapterStats();
  }

  async function resetChapterLearningState(chapter) {
    if (!confirm(`确定重置“${chapter}”的答题记录？当前练习、测验记录、错题本和收藏不会改变。`)) return;
    const { error } = await state.client.from('user_learning_states').delete().eq('user_id', state.user.id).eq('chapter', chapter);
    if (error) { showToast(`重置失败：${error.message}`, 'error'); return; }
    state.learningRevision++;
    learningStates = learningStates.filter(row => row.chapter !== chapter);
    state.learningStates = learningStates;
    try {
      const queue = JSON.parse(localStorage.getItem('pending_learning_states_v1') || '[]').filter(row => row.chapter !== chapter);
      localStorage.setItem('pending_learning_states_v1', JSON.stringify(queue));
    } catch (_) { /* 本地队列清理失败不会影响云端重置 */ }
    updatePracticeInfo();
    renderChapterStats();
  }

  async function deleteAssessmentSession(sessionId) {
    if (currentSession?.id === String(sessionId)) { showToast('正在进行的练习不能删除，请先交卷或退出。', 'error'); return; }
    if (!confirm('确定删除这条测验记录？不会改变累积已答和章节统计。')) return;
    const { error } = await state.client.from('study_sessions').delete().eq('id', sessionId).eq('user_id', state.user.id);
    if (error) { showToast(`删除失败：${error.message}`, 'error'); return; }
    state.historyExpanded.delete(String(sessionId));
    state.selectedHistoryQuestion.delete(String(sessionId));
    state.sessionQuestionCache.delete(String(sessionId));
    await refreshHistory();
  }

  async function refreshUsers() {
    if (!state.client || state.profile?.role !== 'super_admin') return;
    const summaryEl = document.getElementById('userAdminSummary');
    const listEl = document.getElementById('userAdminList');
    if (!summaryEl || !listEl) return;
    summaryEl.textContent = '正在读取用户...';
    try {
      const users = await fetchAll(
        'profiles',
        'id,email,display_name,role,status,created_at',
        'created_at',
        false
      );
      const pending = users.filter(user => user.status === 'pending').length;
      summaryEl.textContent = `共 ${users.length} 个账号 · 待审核 ${pending} 个`;
      listEl.innerHTML = users.map(user => {
        const isSelf = user.id === state.user.id;
        const isAdmin = user.role === 'super_admin';
        let action = '<span class="cloud-status">—</span>';
        if (!isSelf && !isAdmin) {
          if (user.status === 'pending') action = `<button class="btn btn-success" data-user-action="active" data-user-id="${cloudEscape(user.id)}">审核通过</button>`;
          else if (user.status === 'active') action = `<button class="btn btn-danger" data-user-action="suspended" data-user-id="${cloudEscape(user.id)}">暂停账号</button>`;
          else if (user.status === 'suspended') action = `<button class="btn btn-primary" data-user-action="active" data-user-id="${cloudEscape(user.id)}">恢复账号</button>`;
        }
        return `<div class="admin-user-row">
          <div><strong>${cloudEscape(user.display_name || user.email)}</strong><div class="history-time">${cloudEscape(user.email)}</div></div>
          <div>${isAdmin ? '超级管理员' : '普通用户'}</div>
          <div><span class="status-pill ${cloudEscape(user.status)}">${{ pending: '待审核', active: '已启用', suspended: '已暂停' }[user.status] || user.status}</span></div>
          <div>${action}</div>
        </div>`;
      }).join('');
    } catch (error) {
      summaryEl.textContent = `读取失败：${error.message || error}`;
      listEl.innerHTML = '';
    }
  }

  async function setUserStatus(userId, status) {
    const { error } = await state.client.rpc('admin_set_user_status', { p_user_id: userId, p_status: status });
    if (error) { showToast(`更新用户失败：${error.message}`, 'error'); return; }
    showToast(status === 'active' ? '账号已启用' : '账号已暂停', 'success');
    await refreshUsers();
  }

  window.QuizCloud = {
    uploadQuestions,
    refreshQuestions,
    resetPersonalData,
    resetPublicBank,
    scheduleWrongSync,
    scheduleFavoriteSync,
    startActivePractice,
    scheduleActivePracticeSave,
    flushActivePractice,
    waitForActiveSave,
    recordSubmittedAnswer,
    archiveActivePractice,
    finalizeCurrentPractice,
    clearActivePractice,
    refreshHistory,
    refreshUsers
  };

  function bindCloudPanels() {
    const handleSessionListClick = event => {
      const card = event.target.closest('.history-card');
      if (!card) return;
      const sessionId = card.dataset.sessionId;
      const deleteButton = event.target.closest('[data-delete-session]');
      if (deleteButton) { deleteAssessmentSession(sessionId); return; }
      const numberButton = event.target.closest('[data-question-order]');
      if (numberButton) {
        const order = Number(numberButton.dataset.questionOrder);
        state.selectedHistoryQuestion.set(sessionId, order);
        card.querySelectorAll('.question-number-btn').forEach(button => button.classList.toggle('selected', Number(button.dataset.questionOrder) === order));
        const rows = state.sessionQuestionCache.get(sessionId) || [];
        const row = rows.find(item => Number(item.question_order) === order);
        const detail = card.querySelector('[data-question-detail]');
        if (row && detail) detail.innerHTML = buildSessionQuestionDetail(row);
        return;
      }
      const head = event.target.closest('.history-card-head');
      if (!head) return;
      const wasExpanded = state.historyExpanded.has(sessionId);
      if (wasExpanded) state.historyExpanded.delete(sessionId); else state.historyExpanded.add(sessionId);
      card.classList.toggle('expanded', !wasExpanded);
      const detail = card.querySelector('.history-detail');
      detail.classList.toggle('hidden', wasExpanded);
      if (!wasExpanded) loadSessionQuestions(sessionId, detail); else detail.innerHTML = '';
    };
    document.getElementById('mockHistoryList')?.addEventListener('click', handleSessionListClick);
    document.getElementById('randomHistoryList')?.addEventListener('click', handleSessionListClick);
    document.getElementById('chapterStatsList')?.addEventListener('click', event => {
      const button = event.target.closest('[data-reset-chapter]');
      if (button) resetChapterLearningState(button.dataset.resetChapter);
    });
    document.getElementById('resetAllChaptersBtn')?.addEventListener('click', resetAllLearningStates);
    document.getElementById('refreshHistoryBtn')?.addEventListener('click', refreshHistory);
    document.getElementById('refreshUsersBtn')?.addEventListener('click', refreshUsers);
    document.getElementById('userAdminList')?.addEventListener('click', event => {
      const button = event.target.closest('[data-user-action]');
      if (!button) return;
      button.disabled = true;
      setUserStatus(button.dataset.userId, button.dataset.userAction);
    });
  }

  function bindAuthUi() {
    $('authForm').addEventListener('submit', handleAuthSubmit);
    $('authSwitchBtn').addEventListener('click', () => setAuthMode(state.authMode === 'login' ? 'signup' : 'login'));
    $('authResendBtn').addEventListener('click', resendVerification);
    $('authStatusSignOutBtn').addEventListener('click', signOutAndReload);
    $('accountSignOutBtn').addEventListener('click', signOutAndReload);
  }

  async function init() {
    bindCloudPanels();
    bindAuthUi();
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushActivePractice(); });
    window.addEventListener('pagehide', () => { flushActivePractice(); });
    setAuthMode('login');
    showAuthForm();
    if (!window.supabase?.createClient) {
      setAuthNotice('云端组件加载失败，请检查网络后刷新页面。', 'error');
      return;
    }
    if (!config.supabaseUrl || !config.supabaseAnonKey) {
      setAuthNotice('云端配置尚未完成：请在 config.js 中填写 Supabase Project URL 和 Publishable key。', 'error');
      return;
    }
    state.client = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    state.client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT' && state.appStarted) { window.location.reload(); return; }
      if (session) setTimeout(() => routeSession(session), 0);
    });
    try {
      const { data, error } = await state.client.auth.getSession();
      if (error) throw error;
      await routeSession(data.session);
    } catch (error) {
      setAuthNotice(`读取登录状态失败：${friendlyAuthError(error)}`, 'error');
    }
  }

  init();
})();
