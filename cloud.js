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
    historyExpanded: new Set()
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
    ['user_bank_tax_v22', 'public_bank_tax_v22', 'wrongList_tax_v22', 'favorites_tax_v22'].forEach(key => localStorage.removeItem(key));
    if (typeof globalMasterList !== 'undefined') globalMasterList = [];
    if (typeof wrongList !== 'undefined') wrongList = [];
    if (typeof favoritesList !== 'undefined') favoritesList = [];
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
      const key = String(question.text || '').trim();
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
    const available = new Map([...personal, ...publicBank].map(q => [String(q.id), q]));
    saveUserQuestions(personal);
    savePublicQuestions(publicBank);

    wrongList = wrongRows
      .filter(row => available.has(String(row.question_id)))
      .map(row => ({
        qid: String(row.question_id),
        wrongCount: Number(row.wrong_count) || 1,
        lastTime: new Date(row.last_time).getTime(),
        lastUserChoiceTexts: row.last_user_choice_texts || undefined,
        lastSubChoiceTexts: row.last_sub_choice_texts || undefined
      }));
    favoritesList = favoriteRows
      .filter(row => available.has(String(row.question_id)))
      .map(row => ({ qid: String(row.question_id), favTime: new Date(row.fav_time).getTime() }));
    localStorage.setItem('wrongList_tax_v22', JSON.stringify(wrongList));
    localStorage.setItem('favorites_tax_v22', JSON.stringify(favoritesList));
    state.serverWrongIds = new Set(wrongList.map(item => String(item.qid)));
    state.serverFavoriteIds = new Set(favoritesList.map(item => String(item.qid)));

    updateRoleUi();
    if (!state.appStarted) {
      startQuizApp();
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
    const questionRows = questions.map(question => ({
      ...(scope === 'public' ? { uploaded_by: state.user.id } : { owner_id: state.user.id }),
      question_key: questionHash(question),
      payload: cleanQuestionPayload(question)
    }));
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
    saveUserQuestions(personal);
    savePublicQuestions(publicBank);
    rebuildMasterList();
    return { personal: personal.length, public: publicBank.length };
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
          question_source: question.source === 'public' ? 'public' : 'personal',
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
          question_source: question.source === 'public' ? 'public' : 'personal',
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

  function buildCurrentSessionData(kind) {
    const completedAt = new Date();
    const totalQuestions = currentPracticeSet.length;
    let totalSubquestions = 0;
    let answeredCount = 0;
    let correctCount = 0;
    const answerRows = [];

    currentPracticeSet.forEach((question, questionIndex) => {
      const snapshot = JSON.parse(JSON.stringify(question));
      if (isComprehensive(question)) {
        totalSubquestions += question.subQuestions.length;
        const answers = Array.isArray(userAnswers[questionIndex]) ? userAnswers[questionIndex] : [];
        question.subQuestions.forEach((subQuestion, subIndex) => {
          const selected = normalizeLetters(answers[subIndex]);
          const correct = normalizeLetters(subQuestion.correctLetter);
          const answered = selected.length > 0;
          const isCorrect = answered && selected.join('') === correct.join('');
          if (answered) answeredCount++;
          if (isCorrect) correctCount++;
          if (kind === 'mock' || answered) {
            answerRows.push({
              session_id: currentSession.id,
              user_id: state.user.id,
              question_id: String(question.id),
              question_source: question.source === 'public' ? 'public' : 'personal',
              question_text: subQuestion.text,
              sub_index: subIndex + 1,
              question_type: 'comprehensive',
              knowledge: cleanKnowledgeText(question.knowledge) || '未分类',
              year: question.year == null || question.year === '' ? null : Number(question.year),
              user_answer: selected,
              correct_answer: correct,
              is_answered: answered,
              is_correct: isCorrect,
              question_snapshot: { parent: snapshot, subQuestion: JSON.parse(JSON.stringify(subQuestion)) },
              answered_at: completedAt.toISOString()
            });
          }
        });
      } else {
        totalSubquestions++;
        const selected = normalizeLetters(userAnswers[questionIndex]);
        const correct = normalizeLetters(question.correctLetter);
        const answered = selected.length > 0;
        const isCorrect = answered && selected.join('') === correct.join('');
        if (answered) answeredCount++;
        if (isCorrect) correctCount++;
        if (kind === 'mock' || answered) {
          answerRows.push({
            session_id: currentSession.id,
            user_id: state.user.id,
            question_id: String(question.id),
            question_source: question.source === 'public' ? 'public' : 'personal',
            question_text: question.text,
            sub_index: 0,
            question_type: 'single',
            knowledge: cleanKnowledgeText(question.knowledge) || '未分类',
            year: question.year == null || question.year === '' ? null : Number(question.year),
            user_answer: selected,
            correct_answer: correct,
            is_answered: answered,
            is_correct: isCorrect,
            question_snapshot: snapshot,
            answered_at: completedAt.toISOString()
          });
        }
      }
    });

    const durationSeconds = Math.max(0, Math.round((completedAt.getTime() - Number(currentSession.startedAt || Date.now())) / 1000));
    const accuracy = answeredCount > 0 ? Number((correctCount / answeredCount * 100).toFixed(2)) : 0;
    return {
      session: {
        id: currentSession.id,
        user_id: state.user.id,
        mode: currentSession.mode || (kind === 'mock' ? 'mock' : 'practice'),
        label: currentSession.label || (kind === 'mock' ? '模拟测验' : '题库练习'),
        started_at: new Date(currentSession.startedAt || completedAt).toISOString(),
        completed_at: completedAt.toISOString(),
        duration_seconds: durationSeconds,
        total_questions: totalQuestions,
        total_subquestions: totalSubquestions,
        answered_count: answeredCount,
        correct_count: correctCount,
        accuracy,
        metadata: {
          filter_type: typeof currentFilterType === 'string' ? currentFilterType : 'all',
          filter_chapter: typeof currentFilterChapter === 'string' ? currentFilterChapter : 'all',
          mock_duration_minutes: kind === 'mock' ? mockState.durationMin : null
        }
      },
      answers: answerRows
    };
  }

  async function recordCurrentSession(kind = 'practice', statusEl = null) {
    if (!state.client || !state.user || !currentSession) return false;
    if (currentSession.saved) {
      if (statusEl) statusEl.textContent = '本次记录已保存到云端。';
      return true;
    }
    if (currentSession.saving) return false;
    currentSession.saving = true;
    if (statusEl) statusEl.textContent = '正在保存本次成绩和答题明细...';
    try {
      const payload = buildCurrentSessionData(kind);
      if (kind !== 'mock' && payload.answers.length === 0) {
        if (statusEl) statusEl.textContent = '本次没有已作答题目，未生成成绩记录。';
        return false;
      }
      const { error: sessionError } = await state.client.from('practice_sessions').upsert(payload.session, { onConflict: 'id' });
      if (sessionError) throw sessionError;
      const { error: cleanupError } = await state.client.from('answer_history').delete().eq('session_id', currentSession.id).eq('user_id', state.user.id);
      if (cleanupError) throw cleanupError;
      for (let start = 0; start < payload.answers.length; start += 120) {
        const { error } = await state.client.from('answer_history').insert(payload.answers.slice(start, start + 120));
        if (error) throw error;
      }
      currentSession.saved = true;
      if (statusEl) statusEl.textContent = `已保存到云端：${payload.session.correct_count}/${payload.session.answered_count} 正确，正确率 ${payload.session.accuracy.toFixed(1)}%。`;
      const practiceButton = document.getElementById('submitPracticeBtn');
      if (kind !== 'mock' && practiceButton) { practiceButton.disabled = true; practiceButton.innerText = '✅ 本次记录已保存'; }
      if (document.getElementById('historyPanel')?.style.display === 'block') refreshHistory();
      return true;
    } catch (error) {
      console.error('学习记录保存失败', error);
      currentSession.saved = false;
      if (statusEl) {
        statusEl.innerHTML = `保存失败：${cloudEscape(error.message || error)} <button type="button" class="btn btn-outline" data-retry-session="1" style="margin-left:8px;">重试保存</button>`;
        statusEl.querySelector('[data-retry-session]')?.addEventListener('click', () => recordCurrentSession(kind, statusEl));
      } else {
        showToast(`学习记录保存失败：${error.message || error}`, 'error');
      }
      return false;
    } finally {
      currentSession.saving = false;
    }
  }

  function historyModeLabel(mode) {
    return ({
      practice: '题库练习',
      random: '随机练习',
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

  async function loadHistoryDetail(sessionId, detailEl) {
    detailEl.innerHTML = '<div class="cloud-status">正在读取答题明细...</div>';
    try {
      const { data, error } = await state.client.from('answer_history')
        .select('id,question_text,sub_index,question_type,question_source,knowledge,year,user_answer,correct_answer,is_answered,is_correct')
        .eq('session_id', sessionId).eq('user_id', state.user.id).order('id', { ascending: true });
      if (error) throw error;
      if (!data?.length) { detailEl.innerHTML = '<div class="empty-tip">本次没有可显示的答题明细</div>'; return; }
      detailEl.innerHTML = data.map((row, index) => {
        const answer = row.user_answer?.join('') || '未答';
        const correct = row.correct_answer?.join('') || '-';
        return `<div class="history-answer ${row.is_correct ? 'correct' : 'wrong'}">
          <div class="history-answer-title">${index + 1}. ${cloudEscape(row.question_text)}</div>
          <div class="history-answer-meta">${row.question_source === 'public' ? '公共题库' : '我的题库'} · ${cloudEscape(row.knowledge || '未分类')}${row.year ? ` · ${row.year}年` : ''}${row.question_type === 'comprehensive' ? ` · 第${row.sub_index}小问` : ''}</div>
          <div class="history-answer-meta" style="margin-top:5px;">你的答案：<strong>${cloudEscape(answer)}</strong> · 正确答案：<strong>${cloudEscape(correct)}</strong> · ${row.is_correct ? '正确' : (row.is_answered ? '错误' : '未作答')}</div>
        </div>`;
      }).join('');
    } catch (error) {
      detailEl.innerHTML = `<div class="cloud-status" style="color:#b91c1c;">读取失败：${cloudEscape(error.message || error)}</div>`;
    }
  }

  async function refreshHistory() {
    if (!state.client || !state.user || !state.profile) return;
    const summaryEl = document.getElementById('historySummary');
    const listEl = document.getElementById('historyList');
    if (!summaryEl || !listEl) return;
    summaryEl.textContent = '正在读取学习记录...';
    listEl.innerHTML = '';
    try {
      const sessions = await fetchAll(
        'practice_sessions',
        'id,mode,label,started_at,completed_at,duration_seconds,total_questions,total_subquestions,answered_count,correct_count,accuracy',
        'completed_at',
        false
      );
      if (!sessions.length) {
        summaryEl.textContent = '还没有学习记录。完成一次练习或提交模拟测验后会自动出现在这里。';
        listEl.innerHTML = '<div class="empty-tip">📈 暂无成绩和答题历史</div>';
        return;
      }
      const recent = sessions.slice(0, 10);
      const average = recent.reduce((sum, item) => sum + Number(item.accuracy || 0), 0) / recent.length;
      summaryEl.textContent = `共 ${sessions.length} 次记录 · 最近 ${recent.length} 次平均正确率 ${average.toFixed(1)}%`;
      listEl.innerHTML = sessions.map(session => {
        const expanded = state.historyExpanded.has(String(session.id));
        return `<div class="history-card ${expanded ? 'expanded' : ''}" data-session-id="${cloudEscape(session.id)}">
          <div class="history-card-head">
            <div><div class="history-mode">${cloudEscape(historyModeLabel(session.mode))}</div><div class="history-time">${new Date(session.completed_at).toLocaleString()}</div></div>
            <div class="history-stat"><strong>${Number(session.accuracy || 0).toFixed(1)}%</strong>正确率</div>
            <div class="history-stat"><strong>${session.answered_count}/${session.total_subquestions}</strong>已作答</div>
            <div class="history-stat"><strong>${session.correct_count}</strong>答对</div>
            <div class="history-stat"><strong>${formatDuration(session.duration_seconds)}</strong>用时</div>
            <div class="history-chevron">▶</div>
          </div>
          <div class="history-detail ${expanded ? '' : 'hidden'}">${expanded ? '正在读取...' : ''}</div>
        </div>`;
      }).join('');
      for (const session of sessions) {
        if (!state.historyExpanded.has(String(session.id))) continue;
        const detail = listEl.querySelector(`.history-card[data-session-id="${CSS.escape(String(session.id))}"] .history-detail`);
        if (detail) await loadHistoryDetail(session.id, detail);
      }
    } catch (error) {
      summaryEl.textContent = `读取失败：${error.message || error}`;
      listEl.innerHTML = '';
    }
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
    recordCurrentSession,
    refreshHistory,
    refreshUsers
  };

  function bindCloudPanels() {
    document.getElementById('historyList')?.addEventListener('click', event => {
      const head = event.target.closest('.history-card-head');
      if (!head) return;
      const card = head.closest('.history-card');
      const sessionId = card?.dataset.sessionId;
      if (!sessionId) return;
      const wasExpanded = state.historyExpanded.has(sessionId);
      if (wasExpanded) state.historyExpanded.delete(sessionId); else state.historyExpanded.add(sessionId);
      card.classList.toggle('expanded', !wasExpanded);
      const detail = card.querySelector('.history-detail');
      detail.classList.toggle('hidden', wasExpanded);
      if (!wasExpanded) loadHistoryDetail(sessionId, detail); else detail.innerHTML = '';
    });
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
