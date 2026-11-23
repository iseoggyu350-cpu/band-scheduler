(function () {
  'use strict';

  // ===========================================================================
  // 설정
  // ===========================================================================
  const CONFIG = window.BAND_SCHEDULER_CONFIG || {};
  const SUPABASE_URL = String(CONFIG.supabaseUrl || '').trim().replace(/\/+$/, '');
  const SUPABASE_KEY = String(CONFIG.supabaseKey || '').trim();
  const LEGACY_REPO_DEFAULT = String(CONFIG.legacyGithubRepo || '').trim();

  const SESSION_KEY = 'band_scheduler_session_v3';
  const UI_PREFIX = 'band_scheduler_ui_v3_';
  const ADMIN_CODE_KEY = 'band_scheduler_admin_v3';
  // 예전 GitHub 동기화 버전에서 이 기기에 저장해 둔 토큰. 더 이상 쓰지 않으므로 지웁니다.
  const OBSOLETE_KEYS = ['band_rehearsal_github_v1'];

  const DAYS = ['월', '화', '수', '목', '금', '토', '일'];
  const DEFAULT_WEEK_COUNT = 4;
  const MAX_WEEK_COUNT = 12;
  const MAX_SLOTS_PER_MEMBER = 4000;
  const PARTS = [
    { value: '보컬', label: '🎤 보컬' },
    { value: '기타', label: '🎸 기타' },
    { value: '베이스', label: '🎸 베이스' },
    { value: '드럼', label: '🥁 드럼' },
    { value: '건반', label: '🎹 건반' },
    { value: '세션', label: '🎵 기타/세션' }
  ];
  const PART_ICONS = {
    '보컬': '🎤',
    '기타': '🎸',
    '베이스': '🎸',
    '드럼': '🥁',
    '건반': '🎹',
    '세션': '🎵'
  };
  const MEMBER_COLORS = [
    { bg: '#eef2ff', text: '#3730a3', border: '#c7d2fe', dot: '#4f46e5' },
    { bg: '#ecfdf5', text: '#065f46', border: '#a7f3d0', dot: '#10b981' },
    { bg: '#fffbeb', text: '#92400e', border: '#fde68a', dot: '#f59e0b' },
    { bg: '#fff1f2', text: '#9f1239', border: '#fecdd3', dot: '#f43f5e' },
    { bg: '#f0f9ff', text: '#075985', border: '#bae6fd', dot: '#0ea5e9' },
    { bg: '#faf5ff', text: '#6b21a8', border: '#e9d5ff', dot: '#a855f7' },
    { bg: '#f0fdfa', text: '#115e59', border: '#99f6e4', dot: '#14b8a6' },
    { bg: '#fef2f2', text: '#991b1b', border: '#fecaca', dot: '#ef4444' }
  ];
  const TEAM_COLORS = ['#4f46e5', '#059669', '#e11d48', '#d97706', '#0284c7', '#7c3aed', '#0d9488', '#c026d3'];

  // ===========================================================================
  // 작은 도우미들
  // ===========================================================================
  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function readJson(storage, key) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeJson(storage, key, value) {
    try {
      storage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  }

  function removeKey(storage, key) {
    try {
      storage.removeItem(key);
    } catch (e) {}
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  function isUuid(s) {
    return UUID_RE.test(String(s || ''));
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    const b = new Uint8Array(16);
    window.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  }

  function cleanName(s, max) {
    return Array.from(String(s || '').trim()).slice(0, max).join('').trim();
  }

  function teamInitial(name) {
    const chars = Array.from(String(name || '').trim());
    return chars.length ? chars[0].toUpperCase() : '팀';
  }

  function normalizePart(p) {
    return PART_ICONS[p] ? p : '세션';
  }

  function partOptionsHtml(selected) {
    return PARTS.map(p => `<option value="${p.value}"${p.value === selected ? ' selected' : ''}>${p.label}</option>`).join('');
  }

  // ===========================================================================
  // 날짜 도우미 (모두 로컬 날짜 기준, 주는 월요일 시작)
  // ===========================================================================
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function toDateStr(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function parseDateStr(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  function isValidDateStr(s) {
    const d = parseDateStr(s);
    return !!d && toDateStr(d) === String(s).slice(0, 10) && String(s).length === 10;
  }

  function addDaysStr(s, n) {
    const d = parseDateStr(s);
    d.setDate(d.getDate() + n);
    return toDateStr(d);
  }

  function mondayOf(date) {
    const x = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
    return x;
  }

  function normalizeStartDate(s) {
    return toDateStr(mondayOf(parseDateStr(s) || new Date()));
  }

  function currentMondayStr() {
    return toDateStr(mondayOf(new Date()));
  }

  // 새 팀 기본 시작 주: 이번 주 (단, 일요일이면 이번 주가 거의 끝났으니 다음 주)
  function defaultStartDateStr() {
    const t = new Date();
    t.setDate(t.getDate() + 1);
    return toDateStr(mondayOf(t));
  }

  function todayStr() {
    return toDateStr(new Date());
  }

  function dayIdxOfDateStr(s) {
    return (parseDateStr(s).getDay() + 6) % 7;
  }

  function daysBetween(a, b) {
    return Math.round((parseDateStr(b) - parseDateStr(a)) / 86400000);
  }

  function clampWeekCount(n) {
    const v = parseInt(n, 10);
    if (isNaN(v)) return DEFAULT_WEEK_COUNT;
    return Math.min(MAX_WEEK_COUNT, Math.max(1, v));
  }

  function formatMD(s) {
    const d = parseDateStr(s);
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }

  function formatDateLabel(s) {
    return `${formatMD(s)}(${DAYS[dayIdxOfDateStr(s)]})`;
  }

  function formatHour(h) {
    return String(h).padStart(2, '0') + ':00';
  }

  // ===========================================================================
  // 시간 칸 키: "2026-11-23T19" = 2026년 11월 23일 19:00~20:00
  // ===========================================================================
  const SLOT_RE = /^(\d{4}-\d{2}-\d{2})T(\d{1,2})$/;
  // 아주 예전 버전(한 주만 있던 시절)의 "요일-시간" 형식. 예: "5-14" = 토요일 14시
  const LEGACY_SLOT_RE = /^([0-6])-(\d{1,2})$/;

  function makeSlotKey(dateStr, h) {
    return `${dateStr}T${h}`;
  }

  function parseSlotKey(key) {
    const m = SLOT_RE.exec(String(key || ''));
    return m ? { date: m[1], hour: Number(m[2]) } : null;
  }

  function normalizeSlots(slots, startDate) {
    if (!Array.isArray(slots)) return [];
    const out = new Set();
    slots.forEach(s => {
      const str = String(s);
      let m = SLOT_RE.exec(str);
      if (m) {
        const h = Number(m[2]);
        if (h >= 0 && h < 24 && isValidDateStr(m[1])) out.add(makeSlotKey(m[1], h));
        return;
      }
      m = LEGACY_SLOT_RE.exec(str);
      if (m && startDate) {
        const h = Number(m[2]);
        if (h >= 0 && h < 24) out.add(makeSlotKey(addDaysStr(startDate, Number(m[1])), h));
      }
    });
    return Array.from(out);
  }

  function shiftSlotKey(key, deltaDays) {
    const p = parseSlotKey(key);
    return p ? makeSlotKey(addDaysStr(p.date, deltaDays), p.hour) : key;
  }

  // ===========================================================================
  // 이 기기에 기억하는 것: 고른 밴드부 · 팀 · "나"
  // ===========================================================================
  function loadSession() {
    const p = readJson(localStorage, SESSION_KEY) || {};
    const me = {};
    if (p.me && typeof p.me === 'object') {
      Object.keys(p.me).forEach(k => {
        if (isUuid(k) && isUuid(p.me[k])) me[k] = p.me[k];
      });
    }
    return {
      clubId: isUuid(p.clubId) ? p.clubId : null,
      teamId: isUuid(p.teamId) ? p.teamId : null,
      me
    };
  }

  function saveSession() {
    writeJson(localStorage, SESSION_KEY, session);
  }

  // ===========================================================================
  // Supabase 데이터 계층
  // ===========================================================================
  let sb = null;

  function friendlyError(error) {
    const raw = (error && (error.message || error.details || error.hint || error.code)) || String(error || '');
    const msg = String(raw);
    if (/ADMIN_CODE_INVALID/.test(msg)) return '관리자 코드가 맞지 않아요';
    if (/clubs_name_unique|duplicate key/i.test(msg)) return '같은 이름이 이미 있어요';
    if (/Failed to fetch|NetworkError|Load failed|network|fetch failed/i.test(msg)) return '인터넷 연결을 확인해주세요';
    if (/check constraint|violates/i.test(msg)) return '입력값이 올바르지 않아요';
    if (/foreign key/i.test(msg)) return '이미 삭제된 팀이에요';
    if (/permission denied|row-level security|JWT|Invalid API key|No API key|apikey/i.test(msg)) return 'Supabase 설정(키/권한)을 확인해주세요';
    if (/relation .* does not exist|Could not find the (table|function)|schema cache/i.test(msg)) return 'Supabase에 schema.sql을 먼저 실행해주세요';
    return msg || '알 수 없는 오류';
  }

  async function q(builder) {
    let res;
    try {
      res = await builder;
    } catch (e) {
      throw new Error(friendlyError(e));
    }
    if (res && res.error) throw new Error(friendlyError(res.error));
    return res ? res.data : null;
  }

  const db = {
    listClubs() {
      return q(sb.from('clubs').select('id,name,sort_order,created_at')
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true }));
    },
    listTeamClubIds() {
      return q(sb.from('teams').select('id,club_id'));
    },
    listTeams(clubId) {
      return q(sb.from('teams').select('*').eq('club_id', clubId).order('created_at', { ascending: false }));
    },
    listMembersBrief(teamIds) {
      if (!teamIds.length) return Promise.resolve([]);
      return q(sb.from('members').select('id,team_id,name,part,sort_order,created_at').in('team_id', teamIds));
    },
    async getTeam(id) {
      const rows = await q(sb.from('teams').select('*').eq('id', id).limit(1));
      return rows && rows[0] ? rows[0] : null;
    },
    listMembers(teamId) {
      return q(sb.from('members').select('*').eq('team_id', teamId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true }));
    },
    insertTeam(row) {
      return q(sb.from('teams').insert(row));
    },
    updateTeam(id, patch) {
      return q(sb.from('teams').update(patch).eq('id', id));
    },
    deleteTeam(id) {
      return q(sb.from('teams').delete().eq('id', id));
    },
    insertMembers(rows) {
      return q(sb.from('members').insert(rows));
    },
    updateMember(id, patch) {
      return q(sb.from('members').update(patch).eq('id', id));
    },
    deleteMember(id) {
      return q(sb.from('members').delete().eq('id', id));
    },
    rpc(fn, args) {
      return q(sb.rpc(fn, args || {}));
    }
  };

  function teamMetaFromRow(r) {
    return {
      id: r.id,
      clubId: r.club_id,
      name: String(r.name || '팀'),
      colorIdx: Math.abs(Number(r.color_idx) || 0) % TEAM_COLORS.length,
      startDate: normalizeStartDate(r.start_date),
      weekCount: clampWeekCount(r.week_count)
    };
  }

  function memberFromRow(r) {
    return {
      id: r.id,
      name: String(r.name || '멤버'),
      part: normalizePart(r.part),
      colorIdx: Math.abs(Number(r.color_idx) || 0) % MEMBER_COLORS.length,
      sortOrder: Number(r.sort_order) || 0,
      createdAt: r.created_at || '',
      slots: normalizeSlots(r.slots, null)
    };
  }

  function sortMembers(list) {
    return list.slice().sort((a, b) => (a.sortOrder - b.sortOrder) || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  // ===========================================================================
  // 실행 중 상태
  // ===========================================================================
  let session = loadSession();
  let clubs = [];
  let teamMeta = null; // { id, clubId, name, colorIdx }
  let state = null; // 현재 팀 화면 상태 (멤버 + 이 기기 화면 설정)

  let isDragging = false;
  let dragPaintValue = true;
  let renameTargetId = null;
  let editTeamColorIdx = 0;
  let toastTimer = null;
  let lastErrorToastAt = 0;
  let lastScrolledWeek = -1;

  let writeQueue = Promise.resolve();
  let pendingWriteCount = 0;
  let pushDebounceTimer = null;
  const pendingSyncMemberIds = new Set();
  let isFetching = false;
  let fetchRequested = false;
  let localEditSeq = 0;
  let lastSyncError = null;
  let lastSyncTime = null;
  let realtimeChannel = null;
  let realtimeStatus = 'idle';
  let realtimeDebounce = null;
  let pollTimer = null;

  // ===========================================================================
  // 팀별 화면 설정 (이 기기에만 저장)
  // ===========================================================================
  function saveState() {
    if (!state || !teamMeta) return;
    writeJson(localStorage, UI_PREFIX + state.teamId, {
      mode: state.mode,
      startHour: state.startHour,
      endHour: state.endHour,
      activeMemberId: state.activeMemberId,
      minMembers: state.minMembers,
      viewWeek: state.viewWeek,
      recScope: state.recScope,
      excluded: state.members.filter(m => !m.included).map(m => m.id),
      cache: {
        team: {
          id: teamMeta.id,
          club_id: teamMeta.clubId,
          name: teamMeta.name,
          color_idx: teamMeta.colorIdx,
          start_date: state.startDate,
          week_count: state.weekCount
        },
        members: state.members.map(m => ({
          id: m.id,
          name: m.name,
          part: m.part,
          color_idx: m.colorIdx,
          sort_order: m.sortOrder,
          created_at: m.createdAt,
          slots: m.slots
        }))
      }
    });
  }

  function currentWeekIdx(startDate, weekCount) {
    const diff = daysBetween(startDate, todayStr());
    if (diff < 0) return 0;
    return Math.min(weekCount - 1, Math.floor(diff / 7));
  }

  function buildState(meta, memberRows) {
    const prefs = readJson(localStorage, UI_PREFIX + meta.id) || {};
    const excluded = new Set(Array.isArray(prefs.excluded) ? prefs.excluded : []);
    const startHour = typeof prefs.startHour === 'number' ? Math.min(20, Math.max(0, prefs.startHour)) : 9;
    const endHour = typeof prefs.endHour === 'number' ? Math.min(24, Math.max(startHour + 1, prefs.endHour)) : 23;
    const s = {
      teamId: meta.id,
      startDate: meta.startDate,
      weekCount: meta.weekCount,
      mode: prefs.mode === 'edit' ? 'edit' : 'overlap',
      startHour,
      endHour,
      activeMemberId: prefs.activeMemberId || null,
      minMembers: typeof prefs.minMembers === 'number' ? prefs.minMembers : 0,
      inspectedSlot: null,
      viewWeek: typeof prefs.viewWeek === 'number'
        ? Math.min(meta.weekCount - 1, Math.max(0, prefs.viewWeek))
        : currentWeekIdx(meta.startDate, meta.weekCount),
      recScope: prefs.recScope === 'week' ? 'week' : 'all',
      highlightedSlots: [],
      members: sortMembers(memberRows.map(memberFromRow)).map(m => Object.assign(m, { included: !excluded.has(m.id) }))
    };
    if (!s.members.some(m => m.id === s.activeMemberId)) {
      const meId = session.me[meta.id];
      s.activeMemberId = s.members.some(m => m.id === meId) ? meId : (s.members[0] ? s.members[0].id : null);
    }
    return s;
  }

  function getMe() {
    if (!state) return null;
    const meId = session.me[state.teamId];
    return state.members.find(m => m.id === meId) || null;
  }

  function stateSignature(meta, startDate, weekCount, members) {
    return JSON.stringify([
      meta.name, meta.colorIdx, startDate, weekCount,
      members.map(m => [m.id, m.name, m.part, m.colorIdx, m.sortOrder, m.slots.slice().sort().join(',')])
    ]);
  }

  // ===========================================================================
  // 팀 들어가기 / 나가기
  // ===========================================================================
  function enterTeam(teamRow, memberRows, meChoice) {
    leaveTeam();
    teamMeta = teamMetaFromRow(teamRow);
    session.clubId = teamMeta.clubId;
    session.teamId = teamMeta.id;
    if (meChoice !== undefined) {
      if (meChoice) session.me[teamMeta.id] = meChoice;
      else delete session.me[teamMeta.id];
    }
    saveSession();

    state = buildState(teamMeta, memberRows || []);
    if (meChoice) {
      state.activeMemberId = meChoice;
      state.mode = 'edit';
    }
    lastSyncError = null;
    lastSyncTime = memberRows ? new Date() : null;
    lastScrolledWeek = -1;
    localEditSeq++;
    saveState();
    updateTeamHash();
    closeOnboarding();
    playTeamSwitchAnimation();
    renderAll();
    subscribeRealtime(teamMeta.id);
    startPolling();
  }

  function leaveTeam() {
    flushPendingMemberSync();
    saveState();
    unsubscribeRealtime();
    stopPolling();
    state = null;
    teamMeta = null;
  }

  function updateTeamHash() {
    try {
      history.replaceState(null, '', window.location.pathname + window.location.search + (state ? '#t=' + state.teamId : ''));
    } catch (e) {}
  }

  function teamLinkUrl() {
    return `${window.location.origin}${window.location.pathname}#t=${state.teamId}`;
  }

  function playTeamSwitchAnimation() {
    const main = $('appMain');
    main.classList.remove('team-switch-in');
    void main.offsetWidth;
    main.classList.add('team-switch-in');
  }

  function handleTeamDeleted() {
    const name = teamMeta ? teamMeta.name : '이 팀';
    const clubId = teamMeta ? teamMeta.clubId : session.clubId;
    if (state) delete session.me[state.teamId];
    session.teamId = null;
    saveSession();
    leaveTeam();
    showToast(`'${name}' 팀이 삭제되어 팀 목록으로 돌아왔어요.`);
    openOnboarding('team', { clubId });
  }

  // ===========================================================================
  // 동기화 (불러오기 · 저장 · 실시간)
  // ===========================================================================
  function maybeRunRequestedFetch() {
    if (fetchRequested && !isFetching && pendingWriteCount === 0 && !pushDebounceTimer && !isDragging) {
      fetchRequested = false;
      setTimeout(() => refreshTeam(true), 50);
    }
  }

  async function refreshTeam(silent) {
    if (!state || !sb) return false;
    if (isFetching || pendingWriteCount > 0 || pushDebounceTimer || isDragging) {
      fetchRequested = true;
      return false;
    }
    const reqTeamId = state.teamId;
    const reqSeq = localEditSeq;
    isFetching = true;
    renderStatus();
    try {
      const [teamRow, memberRows] = await Promise.all([db.getTeam(reqTeamId), db.listMembers(reqTeamId)]);
      if (!state || state.teamId !== reqTeamId) return true;
      lastSyncError = null;
      lastSyncTime = new Date();
      if (!teamRow) {
        handleTeamDeleted();
        return true;
      }
      if (reqSeq !== localEditSeq || isDragging || pushDebounceTimer || pendingWriteCount > 0) {
        fetchRequested = true;
        return true;
      }
      applyRemote(teamRow, memberRows || []);
      if (!silent) showToast('최신 시간표를 불러왔어요.');
      return true;
    } catch (err) {
      if (state && state.teamId === reqTeamId) {
        lastSyncError = err.message || '연결 오류';
        if (!silent) showToast('불러오기 실패: ' + lastSyncError);
      }
      return false;
    } finally {
      isFetching = false;
      renderStatus();
      maybeRunRequestedFetch();
    }
  }

  function applyRemote(teamRow, memberRows) {
    const meta = teamMetaFromRow(teamRow);
    const members = sortMembers(memberRows.map(memberFromRow));
    const before = stateSignature(teamMeta, state.startDate, state.weekCount, state.members);
    const after = stateSignature(meta, meta.startDate, meta.weekCount, members);
    if (before === after) return;

    teamMeta = meta;
    state.startDate = meta.startDate;
    state.weekCount = meta.weekCount;
    state.viewWeek = Math.min(state.weekCount - 1, Math.max(0, state.viewWeek));
    const includedMap = {};
    state.members.forEach(m => { includedMap[m.id] = m.included; });
    state.members = members.map(m => Object.assign(m, { included: includedMap[m.id] !== undefined ? includedMap[m.id] : true }));
    if (!state.members.some(m => m.id === state.activeMemberId)) {
      const me = getMe();
      state.activeMemberId = me ? me.id : (state.members[0] ? state.members[0].id : null);
    }
    if (state.highlightedSlots.length) state.highlightedSlots = [];
    saveState();
    renderAll();
  }

  function enqueueWrite(taskFn) {
    if (!sb) return Promise.resolve(false);
    pendingWriteCount++;
    renderStatus();
    const run = async () => {
      try {
        await taskFn();
        lastSyncError = null;
        lastSyncTime = new Date();
        return true;
      } catch (err) {
        lastSyncError = err.message || '저장 실패';
        if (Date.now() - lastErrorToastAt > 5000) {
          lastErrorToastAt = Date.now();
          showToast('저장 실패: ' + lastSyncError);
        }
        return false;
      } finally {
        pendingWriteCount = Math.max(0, pendingWriteCount - 1);
        renderStatus();
        maybeRunRequestedFetch();
      }
    };
    const next = writeQueue.then(run, run);
    writeQueue = next.then(() => {}, () => {});
    return next;
  }

  function flushPendingMemberSync() {
    if (pushDebounceTimer) {
      clearTimeout(pushDebounceTimer);
      pushDebounceTimer = null;
    }
    const ids = Array.from(pendingSyncMemberIds);
    pendingSyncMemberIds.clear();
    if (!state || ids.length === 0) return;
    const teamId = state.teamId;
    ids.forEach(id => {
      const m = state.members.find(x => x.id === id);
      if (!m) return;
      const snap = { slots: m.slots.slice(0, MAX_SLOTS_PER_MEMBER), name: m.name, part: m.part };
      enqueueWrite(() => db.updateMember(id, snap)).then(ok => {
        // 실패하면 잠시 뒤 다시 시도 (같은 팀을 보고 있을 때만)
        if (!ok && state && state.teamId === teamId && state.members.some(x => x.id === id)) {
          pendingSyncMemberIds.add(id);
          if (!pushDebounceTimer) pushDebounceTimer = setTimeout(flushPendingMemberSync, 5000);
          renderStatus();
        }
      });
    });
    renderStatus();
  }

  function scheduleMemberSync(member) {
    if (!member || !state) return;
    localEditSeq++;
    pendingSyncMemberIds.add(member.id);
    if (pushDebounceTimer) clearTimeout(pushDebounceTimer);
    pushDebounceTimer = setTimeout(flushPendingMemberSync, 600);
    renderStatus();
  }

  function syncAllMembersSlots() {
    state.members.forEach(m => pendingSyncMemberIds.add(m.id));
    localEditSeq++;
    flushPendingMemberSync();
  }

  function onRealtimeChange() {
    if (realtimeDebounce) clearTimeout(realtimeDebounce);
    realtimeDebounce = setTimeout(() => {
      realtimeDebounce = null;
      refreshTeam(true);
    }, 350);
  }

  function subscribeRealtime(teamId) {
    unsubscribeRealtime();
    if (!sb || typeof sb.channel !== 'function') return;
    try {
      realtimeStatus = 'CONNECTING';
      realtimeChannel = sb.channel('team-' + teamId)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'members', filter: `team_id=eq.${teamId}` }, onRealtimeChange)
        // 삭제 이벤트는 필터가 안 되므로 따로 받아서 이 팀 멤버인지 확인합니다.
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'members' }, (payload) => {
          const oldId = payload && payload.old && payload.old.id;
          if (state && oldId && state.members.some(m => m.id === oldId)) onRealtimeChange();
        })
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'teams', filter: `id=eq.${teamId}` }, onRealtimeChange)
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'teams' }, (payload) => {
          if (state && payload && payload.old && payload.old.id === state.teamId) onRealtimeChange();
        })
        .subscribe((status) => {
          const wasLive = realtimeStatus === 'SUBSCRIBED';
          realtimeStatus = status;
          renderStatus();
          // 다시 연결되면 끊겨 있던 동안의 변경을 한 번 불러옵니다.
          if (status === 'SUBSCRIBED' && !wasLive) refreshTeam(true);
        });
    } catch (e) {
      realtimeStatus = 'CHANNEL_ERROR';
    }
  }

  function unsubscribeRealtime() {
    if (realtimeDebounce) {
      clearTimeout(realtimeDebounce);
      realtimeDebounce = null;
    }
    if (realtimeChannel && sb) {
      try {
        sb.removeChannel(realtimeChannel);
      } catch (e) {}
    }
    realtimeChannel = null;
    realtimeStatus = 'idle';
  }

  // 실시간 연결이 안 될 때를 대비한 자동 새로고침
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(() => {
      if (!state || document.hidden) return;
      const live = realtimeStatus === 'SUBSCRIBED';
      const stale = !lastSyncTime || Date.now() - lastSyncTime.getTime() > 60000;
      if (!live || stale) refreshTeam(true);
    }, 15000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  // ===========================================================================
  // 온보딩: 밴드부(소속) → 팀 → 나는 누구?
  // ===========================================================================
  const ob = {
    open: false,
    step: 'club',
    reqId: 0,
    loading: false,
    error: '',
    clubs: [],
    teamCounts: {},
    clubId: null,
    teams: [],
    membersByTeam: {},
    filter: '',
    teamRow: null,
    teamMembers: []
  };

  function clubName(clubId) {
    const c = clubs.find(x => x.id === clubId) || ob.clubs.find(x => x.id === clubId);
    return c ? c.name : '';
  }

  function openOnboarding(step, opts) {
    const o = opts || {};
    ob.open = true;
    ob.error = '';
    $('onboarding').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (step === 'me' && o.teamId) {
      loadObMe(o.teamId, o);
    } else if (step === 'team' && (o.clubId || session.clubId)) {
      loadObTeams(o.clubId || session.clubId);
    } else {
      loadObClubs();
    }
  }

  function closeOnboarding() {
    ob.open = false;
    ob.reqId++;
    $('onboarding').classList.add('hidden');
    document.body.style.overflow = '';
  }

  async function obLoad(step, loader) {
    const reqId = ++ob.reqId;
    ob.step = step;
    ob.loading = true;
    ob.error = '';
    renderOnboarding();
    try {
      await loader(() => reqId === ob.reqId);
      if (reqId !== ob.reqId) return;
      ob.loading = false;
      renderOnboarding();
    } catch (e) {
      if (reqId !== ob.reqId) return;
      ob.loading = false;
      ob.error = e.message || '불러오기 실패';
      renderOnboarding();
    }
  }

  function loadObClubs() {
    return obLoad('club', async (isCurrent) => {
      const [clubRows, teamRows] = await Promise.all([db.listClubs(), db.listTeamClubIds()]);
      if (!isCurrent()) return;
      clubs = clubRows || [];
      ob.clubs = clubs;
      ob.teamCounts = {};
      (teamRows || []).forEach(t => { ob.teamCounts[t.club_id] = (ob.teamCounts[t.club_id] || 0) + 1; });
    });
  }

  function loadObTeams(clubId) {
    ob.clubId = clubId;
    ob.filter = '';
    return obLoad('team', async (isCurrent) => {
      const [clubRows, teamRows] = await Promise.all([db.listClubs(), db.listTeams(clubId)]);
      if (!isCurrent()) return;
      clubs = clubRows || [];
      ob.clubs = clubs;
      if (!clubs.some(c => c.id === clubId)) {
        // 밴드부가 삭제되었거나 잘못된 주소 → 밴드부 고르기로
        if (session.clubId === clubId) {
          session.clubId = null;
          saveSession();
        }
        throw new Error('이 밴드부를 찾을 수 없어요. 다시 골라주세요.');
      }
      ob.teams = teamRows || [];
      const brief = await db.listMembersBrief(ob.teams.map(t => t.id));
      if (!isCurrent()) return;
      ob.membersByTeam = {};
      (brief || []).forEach(m => {
        (ob.membersByTeam[m.team_id] = ob.membersByTeam[m.team_id] || []).push(memberFromRow(m));
      });
      Object.keys(ob.membersByTeam).forEach(k => { ob.membersByTeam[k] = sortMembers(ob.membersByTeam[k]); });
    });
  }

  function loadObMe(teamId, opts) {
    const o = opts || {};
    return obLoad('me', async (isCurrent) => {
      const [teamRow, memberRows, clubRows] = await Promise.all([db.getTeam(teamId), db.listMembers(teamId), clubs.length ? Promise.resolve(clubs) : db.listClubs()]);
      if (!isCurrent()) return;
      clubs = clubRows || [];
      if (!teamRow) {
        if (session.teamId === teamId) {
          session.teamId = null;
          saveSession();
        }
        ob.clubId = ob.clubId || session.clubId;
        throw new Error('이 팀을 찾을 수 없어요. 삭제되었을 수 있어요.');
      }
      ob.teamRow = teamRow;
      ob.clubId = teamRow.club_id;
      ob.teamMembers = sortMembers((memberRows || []).map(memberFromRow));
      // 이 팀에서 이미 "나"를 골랐던 적이 있으면 바로 들어갑니다.
      const rememberedMe = session.me[teamId];
      if (o.autoEnter && rememberedMe && ob.teamMembers.some(m => m.id === rememberedMe)) {
        enterTeam(teamRow, memberRows || [], rememberedMe);
      }
    });
  }

  function obTopBarHtml() {
    const canClose = !!state;
    let back = '';
    if (ob.step === 'team') {
      back = `<button type="button" data-act="ob-back-club" class="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-200/70">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>밴드부</button>`;
    } else if (ob.step === 'me') {
      back = `<button type="button" data-act="ob-back-team" class="inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-200/70">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2.2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7"/></svg>팀 목록</button>`;
    }
    const steps = ['club', 'team', 'me'];
    const idx = steps.indexOf(ob.step);
    const dots = steps.map((s, i) => `<span class="h-1.5 rounded-full transition-all ${i === idx ? 'w-5 bg-indigo-600' : i < idx ? 'w-1.5 bg-indigo-300' : 'w-1.5 bg-slate-300'}"></span>`).join('');
    return `
      <div class="min-w-[88px]">${back}</div>
      <div class="flex items-center gap-1" aria-hidden="true">${dots}</div>
      <div class="min-w-[88px] flex justify-end">${canClose ? `<button type="button" data-act="ob-close" class="p-2 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-200/70" aria-label="닫기" title="보던 팀으로 돌아가기">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></button>` : ''}</div>
    `;
  }

  function obHeading(emoji, title, sub) {
    return `
      <div class="text-center pt-4 pb-6">
        <div class="w-12 h-12 mx-auto rounded-2xl bg-white border border-slate-200 shadow-sm flex items-center justify-center text-2xl">${emoji}</div>
        <h1 class="mt-3 text-xl font-bold tracking-tight text-slate-900">${title}</h1>
        ${sub ? `<p class="mt-1 text-sm text-slate-500 leading-relaxed">${sub}</p>` : ''}
      </div>
    `;
  }

  function obLoadingHtml() {
    return `<div class="py-12 flex flex-col items-center gap-3 text-sm text-slate-500">
      <svg class="w-6 h-6 animate-spin text-indigo-500" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"></path></svg>
      불러오는 중...</div>`;
  }

  function obErrorHtml() {
    return `<div class="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-sm text-rose-800 space-y-3">
      <div>${escapeHtml(ob.error)}</div>
      <div class="flex flex-wrap gap-2">
        <button type="button" data-act="ob-retry" class="px-3 py-1.5 rounded-lg bg-rose-600 text-white text-xs font-semibold hover:bg-rose-700">다시 시도</button>
        <button type="button" data-act="ob-back-club" class="px-3 py-1.5 rounded-lg bg-white border border-rose-200 text-rose-700 text-xs font-semibold hover:bg-rose-100">밴드부 고르기</button>
      </div>
    </div>`;
  }

  function renderOnboarding() {
    if (!ob.open) return;
    $('obTopBar').innerHTML = obTopBarHtml();
    const body = $('obBody');
    let html = '';

    if (ob.step === 'club') {
      html += obHeading('🎸', '어느 밴드부인가요?', '소속 밴드부를 고르면 그 밴드부의 팀만 보여요.');
      if (ob.loading) {
        html += obLoadingHtml();
      } else if (ob.error) {
        html += obErrorHtml();
      } else if (ob.clubs.length === 0) {
        html += `<div class="p-5 rounded-2xl bg-white border border-dashed border-slate-300 text-center text-sm text-slate-600 leading-relaxed">
          아직 등록된 밴드부가 없어요.<br/>관리자가 먼저 밴드부를 추가해야 해요.
        </div>`;
      } else {
        html += '<div class="space-y-2">';
        ob.clubs.forEach(c => {
          const n = ob.teamCounts[c.id] || 0;
          const isMine = c.id === session.clubId;
          html += `<button type="button" data-act="pick-club" data-id="${c.id}" class="w-full flex items-center gap-3 p-4 rounded-2xl bg-white border ${isMine ? 'border-indigo-400 ring-1 ring-indigo-400' : 'border-slate-200 hover:border-indigo-300'} shadow-sm text-left transition hover:bg-indigo-50/40">
            <span class="w-11 h-11 rounded-xl bg-slate-900 text-white flex items-center justify-center text-lg font-bold shrink-0">${escapeHtml(teamInitial(c.name))}</span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5"><span class="text-base font-bold text-slate-900 truncate">${escapeHtml(c.name)}</span>${isMine ? '<span class="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-indigo-600 text-white">최근</span>' : ''}</span>
              <span class="block text-xs text-slate-500">팀 ${n}개</span>
            </span>
            <svg class="w-5 h-5 text-slate-300 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          </button>`;
        });
        html += '</div>';
      }
      html += `<div class="mt-8 text-center"><button type="button" data-act="open-admin" class="text-xs text-slate-400 hover:text-slate-600 underline-offset-2 hover:underline">관리자</button></div>`;
    } else if (ob.step === 'team') {
      const cName = clubName(ob.clubId);
      html += obHeading('🎶', '어떤 팀인가요?', `<strong class="text-slate-700">${escapeHtml(cName || '밴드부')}</strong>의 곡별 팀이나 고정 팀을 골라주세요.`);
      if (ob.loading) {
        html += obLoadingHtml();
      } else if (ob.error) {
        html += obErrorHtml();
      } else {
        const filter = ob.filter.trim().toLowerCase();
        const mine = (t) => !!session.me[t.id];
        const teams = ob.teams
          .filter(t => !filter || t.name.toLowerCase().includes(filter) || (ob.membersByTeam[t.id] || []).some(m => m.name.toLowerCase().includes(filter)))
          .sort((a, b) => (mine(b) - mine(a)) || (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
        if (ob.teams.length > 5) {
          html += `<div class="mb-3"><input id="obTeamFilter" type="search" value="${escapeHtml(ob.filter)}" placeholder="팀 이름이나 멤버 이름으로 찾기" class="w-full px-3.5 py-2.5 text-sm rounded-xl border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" /></div>`;
        }
        html += '<div id="obTeamList" class="space-y-2">';
        if (ob.teams.length === 0) {
          html += `<div class="p-5 rounded-2xl bg-white border border-dashed border-slate-300 text-center text-sm text-slate-600">아직 팀이 없어요. 아래에서 첫 팀을 만들어보세요!</div>`;
        } else if (teams.length === 0) {
          html += `<div class="p-4 rounded-2xl bg-white border border-dashed border-slate-300 text-center text-sm text-slate-500">'${escapeHtml(ob.filter)}'(으)로 찾은 팀이 없어요.</div>`;
        }
        teams.forEach(t => {
          const members = ob.membersByTeam[t.id] || [];
          const meId = session.me[t.id];
          const me = members.find(m => m.id === meId);
          const color = TEAM_COLORS[Math.abs(t.color_idx || 0) % TEAM_COLORS.length];
          const names = members.slice(0, 6).map(m => m.name).join(', ') + (members.length > 6 ? ` 외 ${members.length - 6}명` : '');
          html += `<button type="button" data-act="pick-team" data-id="${t.id}" class="w-full flex items-center gap-3 p-3.5 rounded-2xl bg-white border ${me ? 'border-indigo-300' : 'border-slate-200'} hover:border-indigo-300 shadow-sm text-left transition hover:bg-indigo-50/40">
            <span class="w-11 h-11 rounded-xl text-white flex items-center justify-center text-lg font-bold shrink-0 shadow-sm" style="background:${color}">${escapeHtml(teamInitial(t.name))}</span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5 min-w-0"><span class="text-[15px] font-bold text-slate-900 truncate">${escapeHtml(t.name)}</span>${me ? `<span class="shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-indigo-600 text-white">내 팀 · ${escapeHtml(me.name)}</span>` : ''}</span>
              <span class="block text-xs text-slate-500 truncate">${members.length ? `멤버 ${members.length}명 · ${escapeHtml(names)}` : '아직 멤버 없음'}</span>
            </span>
            <svg class="w-5 h-5 text-slate-300 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
          </button>`;
        });
        html += '</div>';
        html += `<form id="obCreateTeamForm" class="mt-4 p-3.5 rounded-2xl bg-white border border-slate-200 shadow-sm space-y-2">
          <label for="obNewTeamName" class="block text-xs font-bold text-slate-700">새 팀 만들기</label>
          <div class="flex gap-2">
            <input id="obNewTeamName" type="text" maxlength="30" placeholder="예: 곡 제목, 축제 공연팀" class="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <button type="submit" class="shrink-0 px-3.5 py-2 rounded-lg text-sm font-semibold bg-slate-900 text-white hover:bg-slate-800 transition">+ 만들기</button>
          </div>
          <p class="text-[11px] text-slate-500">곡마다 팀을 따로 만들 수 있어요. 가능 시간은 팀마다 따로 입력해요.</p>
        </form>`;
      }
    } else if (ob.step === 'me') {
      const t = ob.teamRow;
      const tName = t ? t.name : '';
      html += obHeading('🙋', '누구신가요?', t ? `<strong class="text-slate-700">${escapeHtml(clubName(t.club_id))} › ${escapeHtml(tName)}</strong><br/>이름을 고르면 바로 내 가능 시간을 입력할 수 있어요.` : '');
      if (ob.loading) {
        html += obLoadingHtml();
      } else if (ob.error) {
        html += obErrorHtml();
      } else {
        const meId = t ? session.me[t.id] : null;
        if (ob.teamMembers.length === 0) {
          html += `<div class="p-4 rounded-2xl bg-white border border-dashed border-slate-300 text-center text-sm text-slate-600">아직 멤버가 없어요. 첫 멤버로 이름을 추가해주세요.</div>`;
        } else {
          html += '<div class="grid grid-cols-2 gap-2">';
          ob.teamMembers.forEach(m => {
            const c = MEMBER_COLORS[m.colorIdx % MEMBER_COLORS.length];
            const isMe = m.id === meId;
            html += `<button type="button" data-act="pick-me" data-id="${m.id}" class="flex items-center gap-2 p-3 rounded-2xl bg-white border ${isMe ? 'border-indigo-500 ring-2 ring-indigo-500' : 'border-slate-200 hover:border-indigo-300'} shadow-sm text-left transition hover:bg-indigo-50/40 min-w-0">
              <span class="w-9 h-9 rounded-xl flex items-center justify-center text-lg shrink-0" style="background:${c.bg}; border:1px solid ${c.border}">${PART_ICONS[m.part] || '🎵'}</span>
              <span class="min-w-0">
                <span class="block text-sm font-bold text-slate-900 truncate">${escapeHtml(m.name)}</span>
                <span class="block text-[11px] text-slate-500">${escapeHtml(m.part)}${isMe ? ' · 나' : ''}</span>
              </span>
            </button>`;
          });
          html += '</div>';
        }
        html += `<form id="obAddMeForm" class="mt-4 p-3.5 rounded-2xl bg-white border border-slate-200 shadow-sm space-y-2">
          <label for="obMyName" class="block text-xs font-bold text-slate-700">${ob.teamMembers.length ? '목록에 내 이름이 없어요' : '내 이름 추가'}</label>
          <div class="flex flex-wrap sm:flex-nowrap gap-2">
            <input id="obMyName" type="text" maxlength="16" placeholder="이름 (예: 지수)" class="w-full sm:w-auto sm:flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <select id="obMyPart" class="flex-1 sm:flex-none min-w-0 px-2.5 py-2 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">${partOptionsHtml('보컬')}</select>
            <button type="submit" class="shrink-0 px-3.5 py-2 rounded-lg text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 transition">추가하고 시작</button>
          </div>
        </form>
        <div class="mt-5 text-center"><button type="button" data-act="browse-only" class="text-sm font-medium text-slate-500 hover:text-slate-800 underline-offset-2 hover:underline">입력 없이 둘러보기만 할게요</button></div>`;
      }
    }

    body.innerHTML = `<div class="ob-step-in">${html}</div>`;

    const filterInput = $('obTeamFilter');
    if (filterInput) {
      filterInput.addEventListener('input', () => {
        ob.filter = filterInput.value;
        const pos = filterInput.selectionStart;
        renderOnboarding();
        const again = $('obTeamFilter');
        if (again) {
          again.focus();
          try { again.setSelectionRange(pos, pos); } catch (e) {}
        }
      });
    }
  }

  async function obCreateTeam(name) {
    const clean = cleanName(name, 30);
    if (!clean) {
      showToast('새 팀 이름을 입력해주세요.');
      return;
    }
    if (ob.teams.some(t => t.name.trim() === clean)) {
      if (!window.confirm(`'${clean}' 팀이 이미 있어요. 그래도 같은 이름으로 새 팀을 만들까요?`)) return;
    }
    const used = new Set(ob.teams.map(t => t.color_idx));
    let colorIdx = ob.teams.length % TEAM_COLORS.length;
    for (let i = 0; i < TEAM_COLORS.length; i++) {
      if (!used.has(i)) {
        colorIdx = i;
        break;
      }
    }
    const row = {
      id: uuid(),
      club_id: ob.clubId,
      name: clean,
      color_idx: colorIdx,
      start_date: defaultStartDateStr(),
      week_count: DEFAULT_WEEK_COUNT
    };
    try {
      await db.insertTeam(row);
      showToast(`'${clean}' 팀을 만들었어요! 이제 내 이름을 추가해주세요.`);
      loadObMe(row.id);
    } catch (e) {
      showToast('팀 만들기 실패: ' + e.message);
    }
  }

  async function obAddMe(name, part) {
    const clean = cleanName(name, 16);
    if (!clean || !ob.teamRow) {
      showToast('이름을 입력해주세요.');
      return;
    }
    const existing = ob.teamMembers.find(m => m.name === clean);
    if (existing && window.confirm(`'${clean}' 님이 이미 이 팀에 있어요. 그 이름으로 들어갈까요?\n\n(취소를 누르면 같은 이름으로 한 명 더 추가해요)`)) {
      enterTeam(ob.teamRow, ob.teamMembers.map(memberToRow), existing.id);
      return;
    }
    const used = new Set(ob.teamMembers.map(m => m.colorIdx));
    let colorIdx = ob.teamMembers.length % MEMBER_COLORS.length;
    for (let i = 0; i < MEMBER_COLORS.length; i++) {
      if (!used.has(i)) {
        colorIdx = i;
        break;
      }
    }
    const row = {
      id: uuid(),
      team_id: ob.teamRow.id,
      name: clean,
      part: normalizePart(part),
      color_idx: colorIdx,
      sort_order: ob.teamMembers.reduce((mx, m) => Math.max(mx, m.sortOrder), -1) + 1,
      slots: []
    };
    try {
      await db.insertMembers([row]);
      const rows = ob.teamMembers.map(memberToRow).concat([Object.assign({ created_at: new Date().toISOString() }, row)]);
      enterTeam(ob.teamRow, rows, row.id);
      showToast(`환영해요, ${clean}님! 가능한 시간을 칠해주세요.`);
    } catch (e) {
      showToast('추가 실패: ' + e.message);
    }
  }

  function memberToRow(m) {
    return {
      id: m.id,
      name: m.name,
      part: m.part,
      color_idx: m.colorIdx,
      sort_order: m.sortOrder,
      created_at: m.createdAt,
      slots: m.slots
    };
  }

  // 팀 주소(#t=팀ID)로 들어왔을 때
  function openTeamFromLink(teamId) {
    if (state && state.teamId === teamId) return;
    leaveTeam();
    openOnboarding('me', { teamId, autoEnter: true });
  }

  // ===========================================================================
  // 관리자: 밴드부(소속) 관리 · 예전 데이터 가져오기
  // ===========================================================================
  const admin = {
    code: '',
    configured: null,
    checking: false,
    clubs: [],
    teamCounts: {},
    busy: false,
    legacyRepo: LEGACY_REPO_DEFAULT,
    legacy: null,
    legacyLoading: false,
    legacyError: '',
    legacyTargetClub: ''
  };

  function openAdmin() {
    admin.code = String(readJson(sessionStorage, ADMIN_CODE_KEY) || '');
    $('adminModal').classList.remove('hidden');
    $('adminModal').classList.add('flex');
    if (admin.code) {
      loadAdminClubs();
    } else {
      admin.configured = null;
      renderAdmin();
      db.rpc('admin_is_configured').then(v => {
        admin.configured = v === true;
        renderAdminLoginNote();
      }).catch(e => {
        admin.configured = null;
        renderAdminLoginNote();
        showToast(e.message);
      });
    }
  }

  function closeAdmin() {
    $('adminModal').classList.add('hidden');
    $('adminModal').classList.remove('flex');
  }

  function adminLogout() {
    admin.code = '';
    removeKey(sessionStorage, ADMIN_CODE_KEY);
    admin.legacy = null;
    renderAdmin();
  }

  async function adminCall(fn, args) {
    try {
      return await db.rpc(fn, Object.assign({ p_code: admin.code }, args || {}));
    } catch (e) {
      if (/관리자 코드가 맞지 않아요/.test(e.message)) {
        adminLogout();
      }
      throw e;
    }
  }

  async function loadAdminClubs() {
    try {
      const [clubRows, teamRows] = await Promise.all([db.listClubs(), db.listTeamClubIds()]);
      admin.clubs = clubRows || [];
      clubs = admin.clubs;
      admin.teamCounts = {};
      (teamRows || []).forEach(t => { admin.teamCounts[t.club_id] = (admin.teamCounts[t.club_id] || 0) + 1; });
      if (!admin.clubs.some(c => c.id === admin.legacyTargetClub)) {
        admin.legacyTargetClub = admin.clubs[0] ? admin.clubs[0].id : '';
      }
    } catch (e) {
      showToast(e.message);
    }
    renderAdmin();
  }

  function afterClubsChanged() {
    loadAdminClubs();
    if (ob.open && ob.step === 'club') loadObClubs();
    if (state) renderHeader();
  }

  function renderAdmin() {
    const body = $('adminBody');
    if (!admin.code) {
      body.innerHTML = `
        <div id="adminLoginNote"></div>
        <form id="adminLoginForm" class="space-y-2">
          <label for="adminCodeInput" class="block font-semibold text-slate-800">관리자 코드</label>
          <div class="flex gap-2">
            <input id="adminCodeInput" type="password" autocomplete="current-password" class="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
            <button type="submit" class="shrink-0 px-4 py-2 rounded-lg text-sm font-semibold bg-slate-900 text-white hover:bg-slate-800">확인</button>
          </div>
          <p class="text-[11px] text-slate-500">관리자는 밴드부(소속)를 추가·수정·삭제할 수 있어요. 팀은 학생 누구나 만들 수 있어요.</p>
        </form>
      `;
      renderAdminLoginNote();
      setTimeout(() => { const i = $('adminCodeInput'); if (i && document.activeElement !== i) i.focus(); }, 30);
      return;
    }

    const clubRows = admin.clubs.map((c, i) => `
      <div class="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-white border border-slate-200">
        <div class="min-w-0 flex-1">
          <div class="font-semibold text-sm text-slate-900 truncate">${escapeHtml(c.name)}</div>
          <div class="text-[11px] text-slate-500">팀 ${admin.teamCounts[c.id] || 0}개</div>
        </div>
        <button type="button" data-admin="move-up" data-id="${c.id}" class="p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30" ${i === 0 ? 'disabled' : ''} title="위로">▲</button>
        <button type="button" data-admin="move-down" data-id="${c.id}" class="p-1.5 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30" ${i === admin.clubs.length - 1 ? 'disabled' : ''} title="아래로">▼</button>
        <button type="button" data-admin="rename" data-id="${c.id}" class="px-2 py-1 rounded-md font-semibold text-indigo-600 hover:bg-indigo-50">이름 변경</button>
        <button type="button" data-admin="delete" data-id="${c.id}" class="px-2 py-1 rounded-md font-semibold text-rose-600 hover:bg-rose-50">삭제</button>
      </div>
    `).join('');

    let legacyHtml = '';
    if (admin.legacyLoading) {
      legacyHtml = '<div class="text-[11px] text-slate-500">GitHub 저장소를 확인하는 중...</div>';
    } else if (admin.legacyError) {
      legacyHtml = `<div class="text-[11px] text-rose-600">${escapeHtml(admin.legacyError)}</div>`;
    } else if (admin.legacy) {
      if (admin.legacy.length === 0) {
        legacyHtml = '<div class="text-[11px] text-slate-500">가져올 팀이 없어요.</div>';
      } else {
        const targetTeams = admin.legacyExistingNames || new Set();
        legacyHtml = `
          <div class="space-y-1.5">
            ${admin.legacy.map((t, i) => {
              const dup = targetTeams.has(t.name);
              return `<label class="flex items-center gap-2 px-3 py-2 rounded-lg bg-white border border-slate-200 ${dup ? 'opacity-60' : ''}">
                <input type="checkbox" data-legacy-idx="${i}" class="w-4 h-4 accent-indigo-600" ${t.checked && !dup ? 'checked' : ''} ${dup ? 'disabled' : ''} />
                <span class="min-w-0 flex-1">
                  <span class="block font-semibold text-slate-800 truncate">${escapeHtml(t.name)}</span>
                  <span class="block text-[11px] text-slate-500 truncate">${t.members.length}명${t.members.length ? ' · ' + escapeHtml(t.members.map(m => m.name).join(', ')) : ''} · ${t.weekCount}주 (${formatMD(t.startDate)}~)</span>
                </span>
                ${dup ? '<span class="shrink-0 text-[10px] font-semibold text-slate-500">이미 있음</span>' : ''}
              </label>`;
            }).join('')}
          </div>
          <div class="flex flex-wrap items-center gap-2">
            <label for="legacyTargetClub" class="font-semibold text-slate-700">가져올 밴드부</label>
            <select id="legacyTargetClub" class="flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white">
              ${admin.clubs.map(c => `<option value="${c.id}" ${c.id === admin.legacyTargetClub ? 'selected' : ''}>${escapeHtml(c.name)}</option>`).join('')}
            </select>
            <button type="button" data-admin="legacy-import" class="shrink-0 px-3 py-1.5 rounded-lg font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50" ${admin.clubs.length ? '' : 'disabled'}>선택한 팀 가져오기</button>
          </div>
          ${admin.clubs.length ? '' : '<div class="text-[11px] text-amber-700">먼저 위에서 밴드부를 하나 이상 추가해주세요.</div>'}
        `;
      }
    }

    body.innerHTML = `
      <section class="space-y-2">
        <div class="flex items-center justify-between">
          <h4 class="font-bold text-slate-900 text-sm">밴드부(소속) 목록</h4>
          <span class="text-[11px] text-slate-500">${admin.clubs.length}개</span>
        </div>
        <div class="space-y-1.5">${clubRows || '<div class="px-3 py-2 rounded-xl border border-dashed border-slate-300 text-slate-500">아직 밴드부가 없어요.</div>'}</div>
        <form id="adminAddClubForm" class="flex gap-2">
          <input id="adminNewClubName" type="text" maxlength="30" placeholder="새 밴드부 이름 (예: 메아리)" class="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          <button type="submit" class="shrink-0 px-3.5 py-2 rounded-lg text-sm font-semibold bg-slate-900 text-white hover:bg-slate-800">+ 추가</button>
        </form>
      </section>

      <section class="space-y-2 p-3 rounded-xl bg-slate-50 border border-slate-200">
        <h4 class="font-bold text-slate-900 text-sm">예전 데이터 가져오기 (GitHub 동기화 버전)</h4>
        <p class="text-[11px] text-slate-500 leading-relaxed">예전 버전에서 GitHub <code class="font-mono">data</code> 브랜치에 저장된 팀과 시간을 그대로 옮겨와요. 공개 저장소라 토큰은 필요 없어요.</p>
        <div class="flex gap-2">
          <input id="legacyRepoInput" type="text" value="${escapeHtml(admin.legacyRepo)}" placeholder="아이디/저장소명" class="flex-1 min-w-0 px-3 py-1.5 font-mono rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          <button type="button" data-admin="legacy-load" class="shrink-0 px-3 py-1.5 rounded-lg font-semibold bg-white border border-slate-300 text-slate-700 hover:bg-slate-100">불러오기</button>
        </div>
        ${legacyHtml}
      </section>

      <section class="space-y-2">
        <h4 class="font-bold text-slate-900 text-sm">관리자 코드 바꾸기</h4>
        <form id="adminChangeCodeForm" class="flex gap-2">
          <input id="adminNewCode" type="password" autocomplete="new-password" minlength="4" placeholder="새 코드 (4글자 이상)" class="flex-1 min-w-0 px-3 py-2 text-sm rounded-lg border border-slate-300 focus:outline-none focus:ring-2 focus:ring-indigo-500" />
          <button type="submit" class="shrink-0 px-3.5 py-2 rounded-lg text-sm font-semibold bg-white border border-slate-300 text-slate-700 hover:bg-slate-100">변경</button>
        </form>
      </section>

      <div class="flex justify-end">
        <button type="button" data-admin="logout" class="px-3 py-1.5 rounded-lg font-medium text-slate-500 hover:bg-slate-100">관리자 로그아웃</button>
      </div>
    `;
  }

  // 로그인 화면의 안내 문구만 바꿉니다 (입력 중인 코드 칸은 건드리지 않음).
  function renderAdminLoginNote() {
    const el = $('adminLoginNote');
    if (!el) return;
    el.innerHTML = admin.configured === false
      ? `<div class="mb-4 p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 leading-relaxed">
          아직 관리자 코드가 설정되지 않았어요. Supabase 대시보드의 <strong>SQL Editor</strong>에서 아래 한 줄을 실행해 코드를 정해주세요.
          <code class="block mt-1.5 px-2 py-1 bg-white rounded font-mono text-[11px]">select public.set_admin_code('원하는-코드');</code>
        </div>`
      : '';
  }

  // 예전 GitHub 버전 데이터 파일 형식을 정리합니다.
  function parseLegacyDoc(parsed, fallbackName) {
    const obj = parsed && typeof parsed === 'object' ? parsed : {};
    const teamObj = obj.team && typeof obj.team === 'object' ? obj.team : null;
    const startDate = teamObj && isValidDateStr(teamObj.startDate) ? normalizeStartDate(teamObj.startDate) : defaultStartDateStr();
    const rawMembers = obj.members && typeof obj.members === 'object' ? obj.members : (teamObj ? {} : obj);
    const members = [];
    Object.keys(rawMembers).forEach((key, idx) => {
      const m = rawMembers[key];
      if (!m || typeof m !== 'object' || Array.isArray(m)) return;
      members.push({
        name: cleanName(m.name, 16) || '멤버',
        part: normalizePart(m.part),
        colorIdx: typeof m.colorIdx === 'number' ? Math.abs(m.colorIdx) % MEMBER_COLORS.length : idx % MEMBER_COLORS.length,
        order: typeof m.order === 'number' ? m.order : idx,
        slots: normalizeSlots(m.slots, startDate).slice(0, MAX_SLOTS_PER_MEMBER)
      });
    });
    members.sort((a, b) => a.order - b.order);
    return {
      name: cleanName(teamObj && teamObj.name, 30) || fallbackName,
      colorIdx: teamObj && typeof teamObj.colorIdx === 'number' ? Math.abs(teamObj.colorIdx) % TEAM_COLORS.length : 0,
      startDate,
      weekCount: clampWeekCount(teamObj && teamObj.weekCount),
      members
    };
  }

  async function fetchLegacyFile(repo, path) {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=data`, {
        headers: { Accept: 'application/vnd.github.raw+json' },
        cache: 'no-store'
      });
      if (res.status === 404) return null;
      if (res.ok) return JSON.parse((await res.text()).replace(/^﻿/, ''));
    } catch (e) {}
    // API 한도에 걸리면 raw 주소로 다시 시도
    const res2 = await fetch(`https://raw.githubusercontent.com/${repo}/data/${path}`, { cache: 'no-store' });
    if (res2.status === 404) return null;
    if (!res2.ok) throw new Error(`${path} 불러오기 실패 (HTTP ${res2.status})`);
    return JSON.parse((await res2.text()).replace(/^﻿/, ''));
  }

  async function loadLegacy() {
    const repo = String(($('legacyRepoInput') || {}).value || admin.legacyRepo).trim()
      .replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/^\/+|\/+$/g, '');
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      showToast('저장소를 "아이디/저장소명" 형식으로 입력해주세요.');
      return;
    }
    admin.legacyRepo = repo;
    admin.legacyLoading = true;
    admin.legacyError = '';
    admin.legacy = null;
    renderAdmin();
    try {
      const paths = [{ path: 'schedule.json', fallbackName: '우리 밴드' }];
      const listRes = await fetch(`https://api.github.com/repos/${repo}/contents/teams?ref=data`, {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store'
      });
      if (listRes.ok) {
        const arr = await listRes.json();
        if (Array.isArray(arr)) {
          arr.forEach(f => {
            if (f && f.type === 'file' && /^[A-Za-z0-9_-]+\.json$/.test(f.name)) {
              paths.push({ path: `teams/${f.name}`, fallbackName: '가져온 팀' });
            }
          });
        }
      } else if (listRes.status !== 404) {
        throw new Error(`저장소 확인 실패 (HTTP ${listRes.status}). 잠시 뒤 다시 시도해주세요.`);
      }
      const docs = await Promise.all(paths.map(async p => {
        const parsed = await fetchLegacyFile(repo, p.path);
        return parsed ? parseLegacyDoc(parsed, p.fallbackName) : null;
      }));
      admin.legacy = docs.filter(Boolean).map(d => Object.assign(d, { checked: d.members.length > 0 }));
      await refreshLegacyDuplicates();
    } catch (e) {
      admin.legacyError = e.message || '불러오기 실패';
    } finally {
      admin.legacyLoading = false;
      renderAdmin();
    }
  }

  async function refreshLegacyDuplicates() {
    admin.legacyExistingNames = new Set();
    if (!admin.legacyTargetClub) return;
    try {
      const teams = await db.listTeams(admin.legacyTargetClub);
      admin.legacyExistingNames = new Set((teams || []).map(t => t.name));
    } catch (e) {}
  }

  async function importLegacy() {
    if (!admin.legacy || !admin.legacyTargetClub) return;
    const picked = admin.legacy.filter(t => t.checked && !(admin.legacyExistingNames || new Set()).has(t.name));
    if (picked.length === 0) {
      showToast('가져올 팀을 골라주세요.');
      return;
    }
    const target = admin.clubs.find(c => c.id === admin.legacyTargetClub);
    if (!window.confirm(`${picked.length}개 팀을 '${target ? target.name : ''}' 밴드부로 가져올까요?`)) return;
    admin.busy = true;
    let done = 0;
    try {
      for (const t of picked) {
        const teamId = uuid();
        await db.insertTeam({
          id: teamId,
          club_id: admin.legacyTargetClub,
          name: t.name,
          color_idx: t.colorIdx,
          start_date: t.startDate,
          week_count: t.weekCount
        });
        if (t.members.length) {
          await db.insertMembers(t.members.map((m, i) => ({
            id: uuid(),
            team_id: teamId,
            name: m.name,
            part: m.part,
            color_idx: m.colorIdx,
            sort_order: i,
            slots: m.slots
          })));
        }
        done++;
      }
      showToast(`${done}개 팀을 가져왔어요!`);
    } catch (e) {
      showToast(`가져오기 중 오류 (${done}개 완료): ${e.message}`);
    } finally {
      admin.busy = false;
      await refreshLegacyDuplicates();
      afterClubsChanged();
    }
  }

  // ===========================================================================
  // 계산 도우미 (겹침 · 추천)
  // ===========================================================================
  function getWeekDates(weekIdx) {
    const start = addDaysStr(state.startDate, weekIdx * 7);
    const dates = [];
    for (let i = 0; i < 7; i++) dates.push(addDaysStr(start, i));
    return dates;
  }

  function weekRangeText(weekIdx) {
    const dates = getWeekDates(weekIdx);
    return `${formatMD(dates[0])}~${formatMD(dates[6])}`;
  }

  function periodEndStr(s) {
    return addDaysStr(s.startDate, s.weekCount * 7 - 1);
  }

  function weekIdxOfDate(dateStr) {
    const diff = daysBetween(state.startDate, dateStr);
    if (diff < 0) return -1;
    const w = Math.floor(diff / 7);
    return w < state.weekCount ? w : -1;
  }

  function isPastWeek(weekIdx) {
    return getWeekDates(weekIdx)[6] < todayStr();
  }

  function getIncludedMembers() {
    return state.members.filter(m => m.included);
  }

  function getActiveMember() {
    return state.members.find(m => m.id === state.activeMemberId) || state.members[0] || null;
  }

  // 포함된 멤버들의 시간을 Set 으로 한 번만 만들어서 빠르게 조회합니다.
  function makeAvailabilityLookup() {
    const included = getIncludedMembers();
    const sets = included.map(m => ({ m, set: new Set(m.slots) }));
    return function (slotKey) {
      const available = [];
      const unavailable = [];
      sets.forEach(({ m, set }) => {
        if (set.has(slotKey)) available.push(m);
        else unavailable.push(m);
      });
      return { available, unavailable, total: included.length };
    };
  }

  function getOverlapStyle(count, total) {
    if (total === 0 || count === 0) {
      return { bg: '#ffffff', text: '#cbd5e1', border: '#e2e8f0', isAll: false };
    }
    if (count === total) {
      return { bg: '#10b981', text: '#ffffff', border: '#059669', isAll: true };
    }
    const ratio = count / total;
    if (ratio >= 0.75) {
      return { bg: '#6ee7b7', text: '#064e3b', border: '#34d399', isAll: false };
    }
    if (ratio >= 0.5) {
      return { bg: '#a7f3d0', text: '#065f46', border: '#6ee7b7', isAll: false };
    }
    if (ratio >= 0.25) {
      return { bg: '#d1fae5', text: '#047857', border: '#a7f3d0', isAll: false };
    }
    return { bg: '#ecfdf5', text: '#059669', border: '#d1fae5', isAll: false };
  }

  function getEffectiveMin(total) {
    return state.minMembers > 0
      ? Math.min(state.minMembers, total)
      : Math.max(1, Math.min(total, total >= 2 ? Math.max(2, total - 1) : 1));
  }

  function computeBlocksForWeek(weekIdx, lookup, effectiveMin) {
    const blocks = [];
    getWeekDates(weekIdx).forEach((dateStr, d) => {
      let currentBlock = null;
      for (let h = state.startHour; h < state.endHour; h++) {
        const key = makeSlotKey(dateStr, h);
        const { available, total } = lookup(key);
        const idsKey = available.map(m => m.id).sort().join(',');

        if (available.length >= effectiveMin) {
          if (currentBlock && currentBlock.idsKey === idsKey && currentBlock.endHour === h) {
            currentBlock.endHour = h + 1;
            currentBlock.slots.push(key);
          } else {
            if (currentBlock) blocks.push(currentBlock);
            currentBlock = {
              weekIdx,
              dateStr,
              dayIdx: d,
              startHour: h,
              endHour: h + 1,
              count: available.length,
              total,
              members: available,
              idsKey,
              slots: [key]
            };
          }
        } else if (currentBlock) {
          blocks.push(currentBlock);
          currentBlock = null;
        }
      }
      if (currentBlock) blocks.push(currentBlock);
    });

    blocks.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      const durDiff = (b.endHour - b.startHour) - (a.endHour - a.startHour);
      if (durDiff !== 0) return durDiff;
      if (a.dateStr !== b.dateStr) return a.dateStr < b.dateStr ? -1 : 1;
      return a.startHour - b.startHour;
    });
    return blocks;
  }

  // 주차별 추천 블록 목록: [{ weekIdx, blocks }]
  function computeRecommendationsByWeek() {
    const included = getIncludedMembers();
    const total = included.length;
    const result = [];
    if (total === 0) {
      for (let w = 0; w < state.weekCount; w++) result.push({ weekIdx: w, blocks: [] });
      return result;
    }
    const lookup = makeAvailabilityLookup();
    const effectiveMin = getEffectiveMin(total);
    for (let w = 0; w < state.weekCount; w++) {
      result.push({ weekIdx: w, blocks: computeBlocksForWeek(w, lookup, effectiveMin) });
    }
    return result;
  }

  function computeWeekSummaries() {
    const lookup = makeAvailabilityLookup();
    const total = getIncludedMembers().length;
    const summaries = [];
    for (let w = 0; w < state.weekCount; w++) {
      let best = 0;
      let fullHours = 0;
      getWeekDates(w).forEach(dateStr => {
        for (let h = state.startHour; h < state.endHour; h++) {
          const c = lookup(makeSlotKey(dateStr, h)).available.length;
          if (c > best) best = c;
          if (total > 0 && c === total) fullHours++;
        }
      });
      summaries.push({ best, total, fullHours });
    }
    return summaries;
  }

  function countMemberHours(member, dateSet) {
    let n = 0;
    member.slots.forEach(k => {
      const p = parseSlotKey(k);
      if (p && dateSet.has(p.date)) n++;
    });
    return n;
  }

  // ===========================================================================
  // 화면 그리기
  // ===========================================================================
  function showToast(msg) {
    const toast = $('toast');
    $('toastMessage').textContent = msg;
    toast.classList.remove('opacity-0');
    toast.classList.add('opacity-100');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove('opacity-100');
      toast.classList.add('opacity-0');
    }, 2800);
  }

  function copyText(text, successMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showToast(successMsg);
      }).catch(() => {
        fallbackCopy(text, successMsg);
      });
    } else {
      fallbackCopy(text, successMsg);
    }
  }

  function fallbackCopy(text, successMsg) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast(successMsg);
    } catch (e) {
      showToast('복사에 실패했습니다. 직접 선택해 복사해주세요.');
    }
    document.body.removeChild(ta);
  }

  function renderStatus() {
    const dot = $('syncStatusDot');
    const label = $('syncStatusLabel');
    const btn = $('btnSyncStatus');
    if (!state) return;
    const timeStr = lastSyncTime ? lastSyncTime.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
    if (pendingWriteCount > 0 || pushDebounceTimer || pendingSyncMemberIds.size > 0) {
      dot.className = 'w-2 h-2 rounded-full bg-amber-500 animate-pulse';
      label.textContent = lastSyncError ? '다시 저장 중...' : '저장 중...';
    } else if (lastSyncError) {
      dot.className = 'w-2 h-2 rounded-full bg-rose-500';
      label.textContent = '연결 오류';
    } else if (realtimeStatus === 'SUBSCRIBED') {
      dot.className = 'w-2 h-2 rounded-full bg-emerald-500';
      label.textContent = '실시간 저장됨';
    } else if (isFetching && !lastSyncTime) {
      dot.className = 'w-2 h-2 rounded-full bg-slate-400 animate-pulse';
      label.textContent = '불러오는 중...';
    } else {
      dot.className = 'w-2 h-2 rounded-full bg-sky-500';
      label.textContent = '저장됨';
    }
    btn.title = (lastSyncError ? `오류: ${lastSyncError}\n` : '') +
      (realtimeStatus === 'SUBSCRIBED' ? '팀원 입력이 실시간으로 반영돼요.' : '15초마다 자동으로 새로고침해요.') +
      (timeStr ? `\n최근 동기화: ${timeStr}` : '') + '\n눌러서 지금 새로고침';
  }

  function renderHeader() {
    const meta = teamMeta || { name: '팀', colorIdx: 0, clubId: null };
    const color = TEAM_COLORS[meta.colorIdx % TEAM_COLORS.length];
    const logo = $('teamLogo');
    logo.style.background = color;
    logo.textContent = teamInitial(meta.name);
    $('teamNameHeading').textContent = meta.name;
    const cName = clubName(meta.clubId);
    $('teamSubheading').textContent =
      `${cName ? cName + ' · ' : ''}${state.weekCount}주 (${formatMD(state.startDate)}~${formatMD(periodEndStr(state))}) · 눌러서 팀 바꾸기`;
    $('footerClubName').textContent = cName ? `${cName} · 밴드 합주 시간표` : '밴드 합주 시간표';
    document.title = `${meta.name} · 합주 시간표`;
    const themeMeta = $('themeColorMeta');
    if (themeMeta) themeMeta.setAttribute('content', color);
  }

  function renderMeBanner() {
    const wrap = $('meBannerText');
    const me = getMe();
    if (me) {
      const c = MEMBER_COLORS[me.colorIdx % MEMBER_COLORS.length];
      wrap.innerHTML = `
        <span class="w-2 h-2 rounded-full shrink-0" style="background:${c.dot}"></span>
        <span class="truncate"><strong>${PART_ICONS[me.part] || ''} ${escapeHtml(me.name)}</strong>님으로 들어와 있어요.</span>
        <button type="button" data-act="change-me" class="shrink-0 font-semibold text-indigo-700 underline underline-offset-2 hover:text-indigo-900">바꾸기</button>
      `;
    } else {
      wrap.innerHTML = `
        <span class="w-2 h-2 rounded-full bg-amber-500 shrink-0"></span>
        <span class="truncate">둘러보는 중이에요. 내 시간을 입력하려면</span>
        <button type="button" data-act="change-me" class="shrink-0 font-semibold text-indigo-700 underline underline-offset-2 hover:text-indigo-900">나는 누구? 고르기</button>
      `;
    }
  }

  function renderWeekBar() {
    const wrap = $('weekTabs');
    const summaries = computeWeekSummaries();
    const today = todayStr();
    wrap.innerHTML = '';

    for (let w = 0; w < state.weekCount; w++) {
      const dates = getWeekDates(w);
      const isActive = w === state.viewWeek;
      const isCurrent = today >= dates[0] && today <= dates[6];
      const isPast = dates[6] < today;
      const s = summaries[w];

      let indicator = '';
      if (s.total > 0 && s.best === s.total) {
        indicator = `<span class="text-[10px] font-bold ${isActive ? 'text-emerald-200' : 'text-emerald-600'}" title="전원 가능한 시간이 있어요">★</span>`;
      } else if (s.best > 0) {
        indicator = `<span class="text-[10px] font-semibold ${isActive ? 'text-indigo-100' : 'text-slate-400'}" title="최대 겹침 인원">${s.best}/${s.total}</span>`;
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `shrink-0 px-2.5 py-1.5 rounded-lg border text-left transition ${
        isActive
          ? 'bg-indigo-600 border-indigo-600 text-white shadow-sm'
          : 'bg-white border-slate-200 text-slate-700 hover:border-indigo-300 hover:bg-indigo-50/50'
      } ${isPast && !isActive ? 'opacity-55' : ''}`;
      btn.innerHTML = `
        <div class="flex items-center gap-1 text-[11px] font-bold leading-tight whitespace-nowrap">
          <span>${w + 1}주차</span>
          ${isCurrent ? `<span class="px-1 rounded text-[9px] font-semibold ${isActive ? 'bg-white/20 text-white' : 'bg-indigo-100 text-indigo-700'}">이번 주</span>` : ''}
          ${indicator}
        </div>
        <div class="text-[10px] leading-tight whitespace-nowrap ${isActive ? 'text-indigo-100' : 'text-slate-500'}">${formatMD(dates[0])}~${formatMD(dates[6])}</div>
      `;
      btn.addEventListener('click', () => goToWeek(w));
      wrap.appendChild(btn);
    }

    $('btnPrevWeek').disabled = state.viewWeek <= 0;
    $('btnNextWeek').disabled = state.viewWeek >= state.weekCount - 1;

    if (lastScrolledWeek !== state.viewWeek) {
      lastScrolledWeek = state.viewWeek;
      const activeBtn = wrap.children[state.viewWeek];
      if (activeBtn) {
        const left = activeBtn.offsetLeft;
        const right = left + activeBtn.offsetWidth;
        if (left < wrap.scrollLeft) {
          wrap.scrollLeft = Math.max(0, left - 8);
        } else if (right > wrap.scrollLeft + wrap.clientWidth) {
          wrap.scrollLeft = right - wrap.clientWidth + 8;
        }
      }
    }
  }

  function goToWeek(w) {
    const next = Math.min(state.weekCount - 1, Math.max(0, w));
    if (next === state.viewWeek) return;
    state.viewWeek = next;
    state.highlightedSlots = [];
    state.inspectedSlot = null;
    saveState();
    renderAll();
  }

  function populateHourSelects() {
    const startSel = $('startHourSelect');
    const endSel = $('endHourSelect');
    startSel.innerHTML = '';
    endSel.innerHTML = '';

    for (let h = 0; h <= 20; h++) {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = formatHour(h);
      if (h === state.startHour) opt.selected = true;
      startSel.appendChild(opt);
    }
    for (let h = Math.max(state.startHour + 1, 10); h <= 24; h++) {
      const opt = document.createElement('option');
      opt.value = h;
      opt.textContent = formatHour(h);
      if (h === state.endHour) opt.selected = true;
      endSel.appendChild(opt);
    }
  }

  function populateMinMembersSelect() {
    const sel = $('minMembersFilter');
    const total = getIncludedMembers().length;
    sel.innerHTML = '';

    const autoOpt = document.createElement('option');
    autoOpt.value = 0;
    autoOpt.textContent = total > 0 ? `자동 (${total >= 2 ? Math.max(2, total - 1) : 1}명+)` : '자동';
    if (state.minMembers === 0) autoOpt.selected = true;
    sel.appendChild(autoOpt);

    for (let i = total; i >= 1; i--) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = i === total ? `전원 (${i}명)` : `${i}명 이상`;
      if (state.minMembers === i) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function renderMembers() {
    const container = $('memberListContainer');
    const badge = $('memberCountBadge');
    const includedCount = getIncludedMembers().length;
    badge.textContent = `${state.members.length}명 (비교 ${includedCount}명)`;
    const me = getMe();

    container.innerHTML = '';
    if (state.members.length === 0) {
      container.innerHTML = `
        <div class="w-full p-3 rounded-xl bg-slate-50 border border-dashed border-slate-300 text-xs text-slate-500 leading-relaxed">
          <strong class="text-slate-700">${escapeHtml(teamMeta.name)}</strong> 팀에 아직 멤버가 없습니다. 위 배너의 <strong>나는 누구?</strong>에서 내 이름을 추가하거나, 오른쪽에서 멤버를 추가해주세요.
          팀원들에게는 <strong>이 팀 링크 복사</strong>로 링크를 보내면 각자 입력할 수 있어요.
        </div>
      `;
      return;
    }

    const weekDateSet = new Set(getWeekDates(state.viewWeek));
    const periodDateSet = new Set();
    for (let w = 0; w < state.weekCount; w++) getWeekDates(w).forEach(d => periodDateSet.add(d));

    state.members.forEach(m => {
      const color = MEMBER_COLORS[m.colorIdx % MEMBER_COLORS.length];
      const isActive = m.id === state.activeMemberId;
      const isMe = me && me.id === m.id;
      const weekHours = countMemberHours(m, weekDateSet);
      const totalHours = countMemberHours(m, periodDateSet);

      const card = document.createElement('div');
      card.className = `group inline-flex items-center gap-1.5 pl-2 pr-1.5 py-1.5 rounded-xl border text-xs transition ${
        isActive && state.mode === 'edit'
          ? 'ring-2 ring-indigo-500 border-indigo-400 bg-indigo-50/70'
          : m.included
            ? 'border-slate-200 bg-white hover:border-slate-300'
            : 'border-dashed border-slate-200 bg-slate-50 opacity-65'
      }`;

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = m.included;
      chk.title = '겹침 계산에 포함';
      chk.className = 'w-3.5 h-3.5 rounded text-emerald-600 focus:ring-emerald-500 cursor-pointer accent-emerald-600';
      chk.addEventListener('change', (e) => {
        e.stopPropagation();
        m.included = chk.checked;
        saveState();
        renderAll();
      });

      const btnSelect = document.createElement('button');
      btnSelect.type = 'button';
      btnSelect.title = `${state.viewWeek + 1}주차 ${weekHours}시간 · 전체 기간 ${totalHours}시간`;
      btnSelect.className = 'flex items-center gap-1.5 text-left font-medium text-slate-800 hover:text-indigo-700';
      btnSelect.innerHTML = `
        <span class="w-2.5 h-2.5 rounded-full shrink-0" style="background:${color.dot}"></span>
        <span>${PART_ICONS[m.part] || '🎵'}</span>
        <span class="font-semibold">${escapeHtml(m.name)}</span>
        ${isMe ? '<span class="px-1 py-px rounded bg-indigo-600 text-white text-[9px] font-bold">나</span>' : ''}
        <span class="text-[11px] text-slate-400 font-normal">(${weekHours}h${state.weekCount > 1 ? ` / 전체 ${totalHours}h` : ''})</span>
      `;
      btnSelect.addEventListener('click', () => {
        state.activeMemberId = m.id;
        state.mode = 'edit';
        state.highlightedSlots = [];
        saveState();
        renderAll();
      });

      const btnEdit = document.createElement('button');
      btnEdit.type = 'button';
      btnEdit.title = '이름/파트 수정';
      btnEdit.className = 'p-1 rounded-md text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 transition';
      btnEdit.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z"/></svg>`;
      btnEdit.addEventListener('click', (e) => {
        e.stopPropagation();
        openRenameModal(m.id);
      });

      const btnDel = document.createElement('button');
      btnDel.type = 'button';
      btnDel.title = '멤버 삭제';
      btnDel.className = 'p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition';
      btnDel.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>`;
      btnDel.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!window.confirm(`'${m.name}' 멤버를 이 팀에서 삭제할까요?\n입력한 가능 시간도 함께 지워지고, 팀원 모두의 화면에서 사라져요.`)) return;
        const removedId = m.id;
        const removedName = m.name;
        localEditSeq++;
        pendingSyncMemberIds.delete(removedId);
        state.members = state.members.filter(x => x.id !== removedId);
        if (state.activeMemberId === removedId) {
          const meNow = getMe();
          state.activeMemberId = meNow ? meNow.id : (state.members[0] ? state.members[0].id : null);
        }
        saveState();
        renderAll();
        showToast(`'${removedName}' 멤버를 삭제했습니다.`);
        enqueueWrite(() => db.deleteMember(removedId));
      });

      card.appendChild(chk);
      card.appendChild(btnSelect);
      card.appendChild(btnEdit);
      card.appendChild(btnDel);
      container.appendChild(card);
    });
  }

  function addSlotsForActiveWeek(member, dayFrom, dayTo, hourFrom, hourTo) {
    const set = new Set(member.slots);
    const dates = getWeekDates(state.viewWeek);
    for (let d = dayFrom; d < dayTo; d++) {
      for (let h = hourFrom; h < hourTo; h++) {
        if (h >= state.startHour && h < state.endHour) set.add(makeSlotKey(dates[d], h));
      }
    }
    member.slots = Array.from(set);
  }

  function renderModeTabsAndContext() {
    const tabOverlap = $('tabOverlap');
    const tabEdit = $('tabEdit');
    const contextBar = $('modeContextBar');
    const activeMember = getActiveMember();
    const me = getMe();
    const weekLabel = `${state.viewWeek + 1}주차`;

    if (state.mode === 'overlap') {
      tabOverlap.className = 'px-3 sm:px-4 py-1.5 rounded-lg text-xs sm:text-sm font-semibold bg-white text-emerald-700 shadow-sm transition';
      tabEdit.className = 'px-3 sm:px-4 py-1.5 rounded-lg text-xs sm:text-sm font-medium text-slate-600 hover:text-slate-900 transition';
      contextBar.innerHTML = `
        <div class="flex items-center gap-2 text-slate-600">
          <span class="inline-block w-2 h-2 rounded-full bg-emerald-500"></span>
          <span>${weekLabel} (${weekRangeText(state.viewWeek)}) · 색이 진할수록 많은 멤버가 겹칩니다. 칸을 클릭해 상세 인원을 확인하세요.</span>
        </div>
        <button id="btnQuickSwitchEdit" type="button" class="text-indigo-600 font-semibold hover:underline">
          + 내 시간 입력하러 가기
        </button>
      `;
      $('btnQuickSwitchEdit').addEventListener('click', switchToMyEdit);
      return;
    }

    tabEdit.className = 'px-3 sm:px-4 py-1.5 rounded-lg text-xs sm:text-sm font-semibold bg-white text-indigo-700 shadow-sm transition';
    tabOverlap.className = 'px-3 sm:px-4 py-1.5 rounded-lg text-xs sm:text-sm font-medium text-slate-600 hover:text-slate-900 transition';

    if (!activeMember) {
      contextBar.innerHTML = `<div class="text-slate-500">먼저 멤버를 추가한 뒤, 이름을 눌러 시간을 입력하세요.</div>`;
      return;
    }

    const color = MEMBER_COLORS[activeMember.colorIdx % MEMBER_COLORS.length];
    const editingOther = me && me.id !== activeMember.id;
    contextBar.innerHTML = `
      <div class="flex items-center gap-2 flex-wrap">
        <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full font-semibold" style="background:${color.bg}; color:${color.text}; border:1px solid ${color.border}">
          <span>${PART_ICONS[activeMember.part] || '🎵'}</span>
          <span>${escapeHtml(activeMember.name)}</span>
          <span>입력 중</span>
        </span>
        ${editingOther ? `<button id="btnBackToMe" type="button" class="px-2 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-amber-800 font-semibold hover:bg-amber-100">내가 아니에요 → ${escapeHtml(me.name)}(나)로</button>` : ''}
        <span class="text-slate-500"><strong class="text-slate-700">${weekLabel}</strong> 칸을 클릭하거나 드래그해서 칠하세요.</span>
      </div>
      <div class="flex items-center gap-1.5 flex-wrap">
        <button id="btnFillWeekdayEve" type="button" class="px-2 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition">평일 저녁(18~22시)</button>
        <button id="btnFillWeekend" type="button" class="px-2 py-1 rounded-md bg-slate-100 hover:bg-slate-200 text-slate-700 font-medium transition">주말 낮(13~18시)</button>
        ${state.weekCount > 1 ? `<button id="btnCopyWeekToAll" type="button" class="px-2 py-1 rounded-md bg-indigo-50 hover:bg-indigo-100 text-indigo-700 font-semibold transition" title="이 주차에 칠한 요일·시간을 다른 모든 주차에 똑같이 적용">이 주 → 모든 주차 복사</button>` : ''}
        <button id="btnClearActiveWeek" type="button" class="px-2 py-1 rounded-md bg-rose-50 hover:bg-rose-100 text-rose-700 font-medium transition">이 주 비우기</button>
      </div>
    `;
    const btnBack = $('btnBackToMe');
    if (btnBack) btnBack.addEventListener('click', switchToMyEdit);
    $('btnFillWeekdayEve').addEventListener('click', () => {
      addSlotsForActiveWeek(activeMember, 0, 5, 18, 22);
      saveState();
      scheduleMemberSync(activeMember);
      renderAll();
      showToast(`${activeMember.name} · ${weekLabel} 평일 저녁 시간을 추가했습니다.`);
    });
    $('btnFillWeekend').addEventListener('click', () => {
      addSlotsForActiveWeek(activeMember, 5, 7, 13, 18);
      saveState();
      scheduleMemberSync(activeMember);
      renderAll();
      showToast(`${activeMember.name} · ${weekLabel} 주말 낮 시간을 추가했습니다.`);
    });
    const btnCopy = $('btnCopyWeekToAll');
    if (btnCopy) {
      btnCopy.addEventListener('click', () => copyWeekPatternToAllWeeks(activeMember));
    }
    $('btnClearActiveWeek').addEventListener('click', () => {
      const weekDates = new Set(getWeekDates(state.viewWeek));
      activeMember.slots = activeMember.slots.filter(k => {
        const p = parseSlotKey(k);
        return !p || !weekDates.has(p.date);
      });
      saveState();
      scheduleMemberSync(activeMember);
      renderAll();
      showToast(`${activeMember.name}의 ${weekLabel} 시간을 비웠습니다.`);
    });
  }

  function switchToMyEdit() {
    const me = getMe();
    if (me) state.activeMemberId = me.id;
    state.mode = 'edit';
    state.highlightedSlots = [];
    saveState();
    renderAll();
    if (!me && state.members.length > 0) {
      showToast('내 이름을 고르면 바로 내 시간을 입력할 수 있어요.');
    }
  }

  function copyWeekPatternToAllWeeks(member) {
    const srcDates = getWeekDates(state.viewWeek);
    const srcSet = new Set(member.slots);
    const pattern = [];
    srcDates.forEach((dateStr, d) => {
      for (let h = 0; h < 24; h++) {
        if (srcSet.has(makeSlotKey(dateStr, h))) pattern.push([d, h]);
      }
    });
    if (pattern.length === 0) {
      showToast(`${state.viewWeek + 1}주차에 입력된 시간이 없습니다. 먼저 칸을 칠해주세요.`);
      return;
    }
    const others = state.weekCount - 1;
    if (!window.confirm(`${member.name}님의 ${state.viewWeek + 1}주차 시간을 나머지 ${others}개 주차에도 똑같이 적용할까요?\n\n(다른 주차에 이미 입력한 시간은 ${state.viewWeek + 1}주차 기준으로 바뀝니다)`)) return;

    const otherDates = new Set();
    for (let w = 0; w < state.weekCount; w++) {
      if (w !== state.viewWeek) getWeekDates(w).forEach(d => otherDates.add(d));
    }
    const next = member.slots.filter(k => {
      const p = parseSlotKey(k);
      return !p || !otherDates.has(p.date);
    });
    for (let w = 0; w < state.weekCount; w++) {
      if (w === state.viewWeek) continue;
      const dates = getWeekDates(w);
      pattern.forEach(([d, h]) => next.push(makeSlotKey(dates[d], h)));
    }
    member.slots = Array.from(new Set(next));
    saveState();
    scheduleMemberSync(member);
    renderAll();
    showToast(`${member.name}의 ${state.viewWeek + 1}주차 시간을 전체 ${state.weekCount}개 주차에 적용했습니다.`);
  }

  function renderDayHeader() {
    const row = $('dayHeaderRow');
    const today = todayStr();
    const dates = getWeekDates(state.viewWeek);
    row.innerHTML = `<div class="text-[11px] font-semibold text-slate-400 py-1.5 flex items-center justify-center">시간</div>` +
      dates.map((dateStr, d) => {
        const isToday = dateStr === today;
        const isPast = dateStr < today;
        const dayColor = d === 5 ? 'text-indigo-600' : d === 6 ? 'text-rose-600' : 'text-slate-700';
        const bg = isToday ? 'bg-indigo-50 ring-2 ring-indigo-500' : d === 5 ? 'bg-indigo-50/70' : d === 6 ? 'bg-rose-50/70' : 'bg-slate-50';
        return `
          <div class="py-1 rounded-lg leading-tight ${bg} ${isPast ? 'opacity-55' : ''}">
            <div class="text-xs font-bold ${dayColor}">${DAYS[d]}${isToday ? '<span class="ml-0.5 text-[9px] text-indigo-600">오늘</span>' : ''}</div>
            <div class="text-[10px] font-medium text-slate-500">${formatMD(dateStr)}</div>
          </div>
        `;
      }).join('');
  }

  function renderGrid() {
    const grid = $('timetableGrid');
    const activeMember = getActiveMember();
    const activeColor = activeMember ? MEMBER_COLORS[activeMember.colorIdx % MEMBER_COLORS.length] : MEMBER_COLORS[0];
    const includedTotal = getIncludedMembers().length;
    const lookup = makeAvailabilityLookup();
    const activeSet = activeMember ? new Set(activeMember.slots) : new Set();
    const highlightedSet = new Set(state.highlightedSlots);
    const dates = getWeekDates(state.viewWeek);

    grid.innerHTML = '';

    for (let h = state.startHour; h < state.endHour; h++) {
      const row = document.createElement('div');
      row.className = 'grid grid-cols-8 gap-1 items-stretch';

      const label = document.createElement('div');
      label.className = 'flex flex-col items-center justify-center pr-1 text-[11px] font-medium text-slate-500 leading-tight';
      label.innerHTML = `<span>${formatHour(h)}</span><span class="text-[9px] text-slate-400">~${formatHour(h + 1)}</span>`;
      row.appendChild(label);

      for (let d = 0; d < 7; d++) {
        const slotKey = makeSlotKey(dates[d], h);
        const cell = document.createElement('div');
        cell.dataset.slot = slotKey;
        const isHighlighted = highlightedSet.has(slotKey);
        const isInspected = state.inspectedSlot === slotKey;

        cell.className = `grid-cell relative h-9 sm:h-10 rounded-lg border flex items-center justify-center text-xs font-semibold cursor-pointer ${
          isHighlighted ? 'highlighted-block' : ''
        } ${isInspected ? 'inspected-cell' : ''}`;

        const { available, total } = lookup(slotKey);

        if (state.mode === 'overlap') {
          const style = getOverlapStyle(available.length, total);
          cell.style.backgroundColor = style.bg;
          cell.style.color = style.text;
          cell.style.borderColor = style.border;

          if (available.length > 0) {
            cell.innerHTML = style.isAll
              ? `<span class="flex items-center gap-0.5"><span>★</span><span>${available.length}</span></span>`
              : `<span>${available.length}</span>`;
          } else {
            cell.innerHTML = `<span class="text-[10px] opacity-40">-</span>`;
          }
        } else {
          const isSelected = activeSet.has(slotKey);
          const othersCount = available.filter(m => !activeMember || m.id !== activeMember.id).length;

          if (isSelected) {
            cell.style.backgroundColor = activeColor.dot;
            cell.style.color = '#ffffff';
            cell.style.borderColor = activeColor.dot;
            cell.innerHTML = `<span>✓</span>${othersCount > 0 ? `<span class="absolute top-0.5 right-1 text-[9px] opacity-85">+${othersCount}</span>` : ''}`;
          } else {
            cell.style.backgroundColor = othersCount > 0 ? '#f8fafc' : '#ffffff';
            cell.style.color = '#94a3b8';
            cell.style.borderColor = '#e2e8f0';
            cell.innerHTML = othersCount > 0
              ? `<span class="text-[10px] text-emerald-600 font-medium">${othersCount}명</span>`
              : '';
          }
        }

        cell.addEventListener('mousedown', (e) => {
          e.preventDefault();
          state.inspectedSlot = slotKey;
          const member = getActiveMember();
          if (state.mode === 'edit' && member) {
            isDragging = true;
            dragPaintValue = !member.slots.includes(slotKey);
            applySlotChange(member, slotKey, dragPaintValue);
            renderAll();
          } else {
            renderSlotInspector();
            updateInspectedHighlight();
          }
        });

        cell.addEventListener('mouseenter', () => {
          const member = getActiveMember();
          if (isDragging && state.mode === 'edit' && member) {
            applySlotChange(member, slotKey, dragPaintValue);
            renderAll();
          } else if (state.mode === 'overlap') {
            state.inspectedSlot = slotKey;
            renderSlotInspector();
            updateInspectedHighlight();
          }
        });

        row.appendChild(cell);
      }
      grid.appendChild(row);
    }

    const legend = $('legendFooter');
    if (state.mode === 'overlap') {
      legend.innerHTML = `
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-semibold text-slate-700">겹침 범례:</span>
          <span class="inline-flex items-center gap-1"><span class="w-3.5 h-3.5 rounded bg-white border border-slate-200 inline-block"></span>0명</span>
          <span class="inline-flex items-center gap-1"><span class="w-3.5 h-3.5 rounded bg-emerald-100 border border-emerald-200 inline-block"></span>일부</span>
          <span class="inline-flex items-center gap-1"><span class="w-3.5 h-3.5 rounded bg-emerald-300 border border-emerald-400 inline-block"></span>다수</span>
          <span class="inline-flex items-center gap-1"><span class="w-3.5 h-3.5 rounded bg-emerald-500 border border-emerald-600 inline-block"></span>★ 전원 (${includedTotal}명)</span>
        </div>
        <span class="text-slate-400">1칸 = 1시간 · ${state.viewWeek + 1}/${state.weekCount}주차</span>
      `;
    } else {
      legend.innerHTML = `
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-semibold text-slate-700">입력 안내:</span>
          <span>빈 칸의 초록 숫자는 다른 멤버 가능 인원입니다. 위의 주차 탭으로 다른 주도 입력하세요.</span>
        </div>
        <span class="text-slate-400">드래그로 여러 시간 연속 선택 가능</span>
      `;
    }
  }

  function updateInspectedHighlight() {
    const cells = document.querySelectorAll('#timetableGrid .grid-cell');
    cells.forEach(c => {
      if (c.dataset.slot === state.inspectedSlot) {
        c.classList.add('inspected-cell');
      } else {
        c.classList.remove('inspected-cell');
      }
    });
  }

  function applySlotChange(member, slotKey, shouldAdd) {
    const idx = member.slots.indexOf(slotKey);
    if (shouldAdd && idx === -1) {
      if (member.slots.length >= MAX_SLOTS_PER_MEMBER) return;
      member.slots.push(slotKey);
      localEditSeq++;
    } else if (!shouldAdd && idx !== -1) {
      member.slots.splice(idx, 1);
      localEditSeq++;
    }
  }

  function renderSlotInspector() {
    const badge = $('inspectorBadge');
    const body = $('slotInspectorBody');
    const parsed = parseSlotKey(state.inspectedSlot);

    if (!parsed) {
      badge.textContent = '칸을 클릭하세요';
      badge.className = 'text-xs font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600';
      body.innerHTML = `<p class="text-xs text-slate-500">시간표의 원하는 1시간 칸을 클릭하면 가능한 멤버와 불가능한 멤버를 확인할 수 있습니다.</p>`;
      return;
    }

    const { available, unavailable, total } = makeAvailabilityLookup()(state.inspectedSlot);
    const w = weekIdxOfDate(parsed.date);

    badge.textContent = `${w >= 0 ? `${w + 1}주차 · ` : ''}${formatDateLabel(parsed.date)} ${formatHour(parsed.hour)}~${formatHour(parsed.hour + 1)}`;
    badge.className = available.length === total && total > 0
      ? 'text-xs font-semibold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 truncate'
      : 'text-xs font-semibold px-2.5 py-0.5 rounded-full bg-indigo-50 text-indigo-700 truncate';

    const availHtml = available.length > 0
      ? available.map(m => {
          const c = MEMBER_COLORS[m.colorIdx % MEMBER_COLORS.length];
          return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium" style="background:${c.bg}; color:${c.text}; border:1px solid ${c.border}">${PART_ICONS[m.part] || ''} ${escapeHtml(m.name)}</span>`;
        }).join('')
      : `<span class="text-xs text-slate-400">없음</span>`;

    const unavailHtml = unavailable.length > 0
      ? unavailable.map(m => `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-500">${PART_ICONS[m.part] || ''} ${escapeHtml(m.name)}</span>`).join('')
      : `<span class="text-xs text-emerald-600 font-medium">${total > 0 ? '전원 참여 가능!' : '비교할 멤버가 없습니다'}</span>`;

    body.innerHTML = `
      <div class="space-y-3">
        <div>
          <div class="text-xs font-semibold text-emerald-700 mb-1.5">가능 (${available.length}/${total}명)</div>
          <div class="flex flex-wrap gap-1.5">${availHtml}</div>
        </div>
        <div>
          <div class="text-xs font-semibold text-slate-500 mb-1.5">불가능 (${unavailable.length}명)</div>
          <div class="flex flex-wrap gap-1.5">${unavailHtml}</div>
        </div>
      </div>
    `;
  }

  function createBlockButton(b) {
    const isAll = b.count === b.total;
    const duration = b.endHour - b.startHour;
    const isActiveHighlight = b.slots.length > 0 && state.highlightedSlots.length === b.slots.length && b.slots.every(s => state.highlightedSlots.includes(s));

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `w-full text-left p-3 rounded-xl border transition ${
      isActiveHighlight
        ? 'border-indigo-500 bg-indigo-50/70 ring-1 ring-indigo-500'
        : isAll
          ? 'border-emerald-200 bg-emerald-50/50 hover:bg-emerald-50'
          : 'border-slate-200 bg-white hover:bg-slate-50'
    }`;

    const memberNames = b.members.map(m => m.name).join(', ');
    btn.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <div class="font-bold text-sm text-slate-900">
          ${formatDateLabel(b.dateStr)} ${formatHour(b.startHour)} ~ ${formatHour(b.endHour)}
        </div>
        <span class="shrink-0 px-2 py-0.5 rounded-full text-[11px] font-bold ${
          isAll ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-700'
        }">
          ${isAll ? '★ 전원 ' + b.count + '명' : b.count + '/' + b.total + '명'}
        </span>
      </div>
      <div class="mt-1 flex items-center justify-between text-xs text-slate-600">
        <span class="truncate pr-2">${escapeHtml(memberNames)}</span>
        <span class="shrink-0 font-semibold text-indigo-600">${duration}시간 연속</span>
      </div>
    `;

    btn.addEventListener('click', () => {
      state.mode = 'overlap';
      state.viewWeek = b.weekIdx;
      state.highlightedSlots = isActiveHighlight ? [] : b.slots.slice();
      state.inspectedSlot = b.slots[0];
      saveState();
      renderAll();
    });
    return btn;
  }

  function renderRecommendations() {
    const list = $('recommendationList');
    const scopeSwitch = $('recScopeSwitch');
    const btnAll = $('recScopeAll');
    const btnWeek = $('recScopeWeek');
    const multiWeek = state.weekCount > 1;
    const scope = multiWeek ? state.recScope : 'week';

    scopeSwitch.classList.toggle('hidden', !multiWeek);
    const onCls = 'px-2.5 py-1 rounded-md font-semibold bg-white text-emerald-700 shadow-sm transition';
    const offCls = 'px-2.5 py-1 rounded-md font-medium text-slate-500 hover:text-slate-800 transition';
    btnAll.className = scope === 'all' ? onCls : offCls;
    btnWeek.className = scope === 'week' ? onCls : offCls;
    btnWeek.textContent = `${state.viewWeek + 1}주차만`;

    const byWeek = computeRecommendationsByWeek();
    list.innerHTML = '';

    const emptyHtml = `
      <div class="p-4 rounded-xl bg-slate-50 border border-dashed border-slate-200 text-center text-xs text-slate-500">
        조건에 맞는 겹치는 시간대가 아직 없습니다.<br/>멤버별 가능 시간을 입력하거나 최소 인원 필터를 낮춰보세요.
      </div>
    `;

    if (scope === 'week') {
      const blocks = byWeek[state.viewWeek] ? byWeek[state.viewWeek].blocks : [];
      if (blocks.length === 0) {
        list.innerHTML = emptyHtml;
        return;
      }
      blocks.forEach(b => list.appendChild(createBlockButton(b)));
      return;
    }

    if (byWeek.every(g => g.blocks.length === 0)) {
      list.innerHTML = emptyHtml;
      return;
    }

    const PER_WEEK = 3;
    byWeek.forEach(group => {
      const w = group.weekIdx;
      const section = document.createElement('div');
      section.className = `space-y-1.5 ${isPastWeek(w) ? 'opacity-60' : ''}`;

      const best = group.blocks[0];
      const head = document.createElement('button');
      head.type = 'button';
      head.className = `w-full flex items-center justify-between gap-2 px-1 pt-1 text-left group`;
      head.innerHTML = `
        <span class="text-xs font-bold ${w === state.viewWeek ? 'text-indigo-700' : 'text-slate-700'}">
          ${w + 1}주차 <span class="font-medium text-slate-400">${weekRangeText(w)}</span>
        </span>
        <span class="text-[11px] font-semibold text-slate-400 group-hover:text-indigo-600">
          ${best ? (best.count === best.total ? '★ 전원 가능' : `최대 ${best.count}/${best.total}명`) : '겹치는 시간 없음'}
          ${group.blocks.length > PER_WEEK ? ` · +${group.blocks.length - PER_WEEK}개` : ''} →
        </span>
      `;
      head.title = '이 주차의 추천 전체 보기';
      head.addEventListener('click', () => {
        state.viewWeek = w;
        state.recScope = 'week';
        state.highlightedSlots = [];
        saveState();
        renderAll();
      });
      section.appendChild(head);

      if (group.blocks.length === 0) {
        const none = document.createElement('div');
        none.className = 'px-3 py-2 rounded-xl border border-dashed border-slate-200 text-[11px] text-slate-400';
        none.textContent = '조건에 맞는 시간이 없습니다.';
        section.appendChild(none);
      } else {
        group.blocks.slice(0, PER_WEEK).forEach(b => section.appendChild(createBlockButton(b)));
      }
      list.appendChild(section);
    });
  }

  function renderAll() {
    if (!state || !teamMeta) return;
    renderHeader();
    renderMeBanner();
    renderWeekBar();
    populateHourSelects();
    populateMinMembersSelect();
    renderMembers();
    renderModeTabsAndContext();
    renderDayHeader();
    renderGrid();
    renderSlotInspector();
    renderRecommendations();
    renderStatus();
  }

  // ===========================================================================
  // 모달
  // ===========================================================================
  function showModal(id) {
    const modal = $(id);
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }

  function hideModal(id) {
    const modal = $(id);
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  function openRenameModal(memberId) {
    const m = state.members.find(x => x.id === memberId);
    if (!m) return;
    renameTargetId = memberId;
    $('renameInput').value = m.name;
    $('renamePartSelect').value = m.part;
    showModal('renameModal');
    $('renameInput').focus();
  }

  function closeRenameModal() {
    hideModal('renameModal');
    renameTargetId = null;
  }

  function openResetModal() {
    $('resetTeamName').textContent = `'${teamMeta.name}' 팀`;
    $('btnClearWeekSlots').textContent = `${state.viewWeek + 1}주차(${weekRangeText(state.viewWeek)}) 시간만 비우기`;
    showModal('resetModal');
  }

  function closeResetModal() {
    hideModal('resetModal');
  }

  function openTeamEditModal() {
    if (!teamMeta) return;
    editTeamColorIdx = teamMeta.colorIdx;
    $('teamEditNameInput').value = teamMeta.name;
    renderTeamColorSwatches();
    showModal('teamEditModal');
    $('teamEditNameInput').focus();
  }

  function closeTeamEditModal() {
    hideModal('teamEditModal');
  }

  function renderTeamColorSwatches() {
    const wrap = $('teamColorSwatches');
    wrap.innerHTML = '';
    TEAM_COLORS.forEach((c, idx) => {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.title = `색상 ${idx + 1}`;
      sw.className = `w-8 h-8 rounded-lg transition ${idx === editTeamColorIdx ? 'ring-2 ring-offset-2 ring-slate-900' : 'hover:scale-105'}`;
      sw.style.background = c;
      sw.addEventListener('click', () => {
        editTeamColorIdx = idx;
        renderTeamColorSwatches();
      });
      wrap.appendChild(sw);
    });
  }

  function populateWeekCountSelect(selected) {
    const sel = $('periodWeekCountSelect');
    sel.innerHTML = '';
    for (let i = 1; i <= MAX_WEEK_COUNT; i++) {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${i}주`;
      if (i === selected) opt.selected = true;
      sel.appendChild(opt);
    }
  }

  function readPeriodForm() {
    const raw = $('periodStartInput').value;
    const startDate = isValidDateStr(raw) ? normalizeStartDate(raw) : state.startDate;
    const weekCount = clampWeekCount($('periodWeekCountSelect').value);
    return { startDate, weekCount };
  }

  function updatePeriodPreview() {
    const { startDate, weekCount } = readPeriodForm();
    const raw = $('periodStartInput').value;
    $('periodStartHint').textContent = isValidDateStr(raw) && raw !== startDate
      ? `→ 그 주 월요일인 ${formatDateLabel(startDate)}부터 시작해요.`
      : `${formatDateLabel(startDate)}부터 시작해요.`;
    $('periodRangePreview').textContent =
      `${formatDateLabel(startDate)} ~ ${formatDateLabel(addDaysStr(startDate, weekCount * 7 - 1))} · 총 ${weekCount}주`;
    const shiftLabel = $('periodShiftLabel');
    const shiftBox = $('periodShiftSlots');
    const delta = daysBetween(state.startDate, startDate);
    shiftBox.disabled = delta === 0;
    shiftLabel.classList.toggle('opacity-50', delta === 0);
    if (delta === 0) shiftBox.checked = false;
  }

  function openPeriodModal() {
    $('periodStartInput').value = state.startDate;
    populateWeekCountSelect(state.weekCount);
    $('periodShiftSlots').checked = false;
    updatePeriodPreview();
    showModal('periodModal');
  }

  function closePeriodModal() {
    hideModal('periodModal');
  }

  // ===========================================================================
  // 이벤트 연결
  // ===========================================================================
  function bindEvents() {
    $('newMemberPart').innerHTML = partOptionsHtml('보컬');
    $('renamePartSelect').innerHTML = partOptionsHtml('보컬');

    window.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        saveState();
        scheduleMemberSync(getActiveMember());
      }
    });

    document.addEventListener('visibilitychange', () => {
      if (!state) return;
      if (document.hidden) {
        // 앱을 내리기 전에 입력 중이던 시간을 바로 저장
        flushPendingMemberSync();
        saveState();
      } else if (!isDragging && !pushDebounceTimer) {
        refreshTeam(true);
      }
    });

    window.addEventListener('pagehide', () => {
      flushPendingMemberSync();
      saveState();
    });

    window.addEventListener('hashchange', () => {
      const id = parseHashTeamId();
      if (id && (!state || id !== state.teamId)) openTeamFromLink(id);
    });

    // 터치로 칠하기. 칸을 칠하면 시간표를 다시 그리면서 손가락 아래 칸이 새 칸으로 바뀌는데,
    // 브라우저는 touchmove/touchend 를 "처음 닿은 칸"(이미 화면에서 빠진 칸)으로 계속 보냅니다.
    // 그래서 그 칸 자체에 리스너를 달아야 드래그 칠하기와 저장이 제대로 됩니다.
    function endTouchPaint() {
      if (!isDragging) return;
      isDragging = false;
      saveState();
      scheduleMemberSync(getActiveMember());
    }

    function onTouchPaintMove(e) {
      if (!isDragging || !state || state.mode !== 'edit') return;
      e.preventDefault();
      const touch = e.touches[0];
      if (!touch) return;
      const el = document.elementFromPoint(touch.clientX, touch.clientY);
      const cell = el ? el.closest('#timetableGrid .grid-cell') : null;
      const activeMember = getActiveMember();
      if (cell && cell.dataset.slot && activeMember) {
        const prevLen = activeMember.slots.length;
        applySlotChange(activeMember, cell.dataset.slot, dragPaintValue);
        if (activeMember.slots.length !== prevLen) {
          renderAll();
        }
      }
    }

    $('timetableGrid').addEventListener('touchstart', (e) => {
      const target = e.target.closest('.grid-cell');
      if (!target || !target.dataset.slot || !state) return;
      const slotKey = target.dataset.slot;
      state.inspectedSlot = slotKey;
      const activeMember = getActiveMember();
      if (state.mode === 'edit' && activeMember) {
        e.preventDefault();
        isDragging = true;
        dragPaintValue = !activeMember.slots.includes(slotKey);
        const onEnd = () => {
          target.removeEventListener('touchmove', onTouchPaintMove);
          target.removeEventListener('touchend', onEnd);
          target.removeEventListener('touchcancel', onEnd);
          endTouchPaint();
        };
        target.addEventListener('touchmove', onTouchPaintMove, { passive: false });
        target.addEventListener('touchend', onEnd);
        target.addEventListener('touchcancel', onEnd);
        applySlotChange(activeMember, slotKey, dragPaintValue);
        renderAll();
      } else {
        renderSlotInspector();
        updateInspectedHighlight();
      }
    }, { passive: false });

    // 안전장치: 혹시 칸에서 끝 이벤트를 못 받았을 때
    window.addEventListener('touchend', endTouchPaint);
    window.addEventListener('touchcancel', endTouchPaint);

    // --- 온보딩 ---
    $('onboarding').addEventListener('click', (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const act = el.dataset.act;
      if (act === 'pick-club') {
        session.clubId = el.dataset.id;
        saveSession();
        loadObTeams(el.dataset.id);
      } else if (act === 'pick-team') {
        loadObMe(el.dataset.id, { autoEnter: true });
      } else if (act === 'pick-me') {
        if (!ob.teamRow) return;
        const rows = ob.teamMembers.map(memberToRow);
        const m = ob.teamMembers.find(x => x.id === el.dataset.id);
        enterTeam(ob.teamRow, rows, el.dataset.id);
        if (m) showToast(`${m.name}님, 가능한 시간을 칠해주세요!`);
      } else if (act === 'browse-only') {
        if (!ob.teamRow) return;
        enterTeam(ob.teamRow, ob.teamMembers.map(memberToRow), null);
        state.mode = 'overlap';
        saveState();
        renderAll();
      } else if (act === 'ob-back-club') {
        loadObClubs();
      } else if (act === 'ob-back-team') {
        loadObTeams(ob.clubId || session.clubId);
      } else if (act === 'ob-retry') {
        if (ob.step === 'team') loadObTeams(ob.clubId);
        else if (ob.step === 'me' && ob.teamRow) loadObMe(ob.teamRow.id);
        else loadObClubs();
      } else if (act === 'ob-close') {
        if (state) closeOnboarding();
      } else if (act === 'open-admin') {
        openAdmin();
      }
    });

    $('onboarding').addEventListener('submit', (e) => {
      e.preventDefault();
      if (e.target.id === 'obCreateTeamForm') {
        obCreateTeam($('obNewTeamName').value);
      } else if (e.target.id === 'obAddMeForm') {
        obAddMe($('obMyName').value, $('obMyPart').value);
      }
    });

    $('btnOpenTeamPicker').addEventListener('click', () => {
      flushPendingMemberSync();
      openOnboarding('team', { clubId: teamMeta ? teamMeta.clubId : session.clubId });
    });

    $('meBanner').addEventListener('click', (e) => {
      const el = e.target.closest('[data-act="change-me"]');
      if (!el || !state) return;
      flushPendingMemberSync();
      openOnboarding('me', { teamId: state.teamId });
    });

    $('btnCopyTeamLink').addEventListener('click', () => {
      if (!state) return;
      copyText(teamLinkUrl(), `'${teamMeta.name}' 팀 링크를 복사했어요! 단톡방에 붙여넣으면 팀원이 바로 들어와요.`);
    });

    $('btnSyncStatus').addEventListener('click', () => {
      flushPendingMemberSync();
      refreshTeam(false);
    });

    // --- 관리자 ---
    $('btnFooterAdmin').addEventListener('click', openAdmin);
    $('btnCloseAdminModal').addEventListener('click', closeAdmin);
    $('adminModal').addEventListener('click', async (e) => {
      if (e.target.id === 'adminModal') {
        closeAdmin();
        return;
      }
      const cb = e.target.closest('[data-legacy-idx]');
      if (cb && admin.legacy) {
        const item = admin.legacy[Number(cb.dataset.legacyIdx)];
        if (item) item.checked = cb.checked;
        return;
      }
      const el = e.target.closest('[data-admin]');
      if (!el || admin.busy) return;
      const act = el.dataset.admin;
      const club = admin.clubs.find(c => c.id === el.dataset.id);
      try {
        if (act === 'rename' && club) {
          const name = window.prompt('새 밴드부 이름', club.name);
          if (name === null) return;
          const clean = cleanName(name, 30);
          if (!clean) return;
          await adminCall('admin_rename_club', { p_id: club.id, p_name: clean });
          showToast('이름을 바꿨어요.');
          afterClubsChanged();
        } else if (act === 'delete' && club) {
          const n = admin.teamCounts[club.id] || 0;
          if (!window.confirm(`'${club.name}' 밴드부를 삭제할까요?\n\n${n > 0 ? `안에 있는 팀 ${n}개와 모든 멤버·시간이 함께 영구 삭제돼요. 되돌릴 수 없어요!` : '팀이 없는 밴드부예요.'}`)) return;
          if (n > 0) {
            const typed = window.prompt(`정말 삭제하려면 밴드부 이름 '${club.name}'을(를) 그대로 입력하세요.`);
            if (typed === null || typed.trim() !== club.name) {
              showToast('이름이 달라서 삭제하지 않았어요.');
              return;
            }
          }
          await adminCall('admin_delete_club', { p_id: club.id });
          if (session.clubId === club.id) {
            session.clubId = null;
            saveSession();
          }
          showToast(`'${club.name}' 밴드부를 삭제했어요.`);
          afterClubsChanged();
          if (state && teamMeta && teamMeta.clubId === club.id) handleTeamDeleted();
        } else if ((act === 'move-up' || act === 'move-down') && club) {
          await adminCall('admin_move_club', { p_id: club.id, p_direction: act === 'move-up' ? -1 : 1 });
          afterClubsChanged();
        } else if (act === 'logout') {
          adminLogout();
        } else if (act === 'legacy-load') {
          await loadLegacy();
        } else if (act === 'legacy-import') {
          await importLegacy();
        }
      } catch (err) {
        showToast(err.message);
      }
    });

    $('adminModal').addEventListener('change', async (e) => {
      if (e.target.id === 'legacyTargetClub') {
        admin.legacyTargetClub = e.target.value;
        await refreshLegacyDuplicates();
        renderAdmin();
      }
    });

    $('adminModal').addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = e.target.id;
      try {
        if (id === 'adminLoginForm') {
          const code = $('adminCodeInput').value.trim();
          if (!code) return;
          const ok = await db.rpc('admin_verify', { p_code: code });
          if (ok === true) {
            admin.code = code;
            writeJson(sessionStorage, ADMIN_CODE_KEY, code);
            showToast('관리자로 로그인했어요.');
            await loadAdminClubs();
          } else {
            showToast('관리자 코드가 맞지 않아요.');
            $('adminCodeInput').select();
          }
        } else if (id === 'adminAddClubForm') {
          const name = cleanName($('adminNewClubName').value, 30);
          if (!name) {
            showToast('밴드부 이름을 입력해주세요.');
            return;
          }
          await adminCall('admin_create_club', { p_name: name });
          showToast(`'${name}' 밴드부를 추가했어요.`);
          afterClubsChanged();
        } else if (id === 'adminChangeCodeForm') {
          const next = $('adminNewCode').value.trim();
          if (next.length < 4) {
            showToast('새 코드는 4글자 이상이어야 해요.');
            return;
          }
          await adminCall('admin_change_code', { p_new_code: next });
          admin.code = next;
          writeJson(sessionStorage, ADMIN_CODE_KEY, next);
          $('adminNewCode').value = '';
          showToast('관리자 코드를 바꿨어요.');
        }
      } catch (err) {
        showToast(err.message);
      }
    });

    // --- 팀 정보 수정 / 삭제 ---
    $('btnOpenTeamEdit').addEventListener('click', openTeamEditModal);
    $('btnCancelTeamEdit').addEventListener('click', closeTeamEditModal);
    $('teamEditModal').addEventListener('click', (e) => {
      if (e.target.id === 'teamEditModal') closeTeamEditModal();
    });
    $('teamEditForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!teamMeta) return;
      const name = cleanName($('teamEditNameInput').value, 30);
      if (!name) return;
      teamMeta.name = name;
      teamMeta.colorIdx = editTeamColorIdx;
      localEditSeq++;
      saveState();
      const teamId = teamMeta.id;
      enqueueWrite(() => db.updateTeam(teamId, { name, color_idx: editTeamColorIdx }));
      closeTeamEditModal();
      renderAll();
      showToast('팀 정보를 수정했습니다.');
    });
    $('btnDeleteTeam').addEventListener('click', async () => {
      if (!teamMeta) return;
      const name = teamMeta.name;
      if (!window.confirm(`'${name}' 팀을 삭제할까요?\n\n멤버 ${state.members.length}명과 입력된 모든 시간이 팀원 모두에게서 영구 삭제돼요.`)) return;
      const teamId = teamMeta.id;
      const clubId = teamMeta.clubId;
      closeTeamEditModal();
      pendingSyncMemberIds.clear();
      try {
        await writeQueue;
        await db.deleteTeam(teamId);
        delete session.me[teamId];
        session.teamId = null;
        saveSession();
        removeKey(localStorage, UI_PREFIX + teamId);
        state = null;
        leaveTeam();
        showToast(`'${name}' 팀을 삭제했어요.`);
        openOnboarding('team', { clubId });
      } catch (err) {
        showToast('삭제 실패: ' + err.message);
      }
    });

    // --- 주차 / 기간 ---
    $('btnPrevWeek').addEventListener('click', () => goToWeek(state.viewWeek - 1));
    $('btnNextWeek').addEventListener('click', () => goToWeek(state.viewWeek + 1));
    $('btnOpenPeriodModal').addEventListener('click', openPeriodModal);
    $('btnCancelPeriod').addEventListener('click', closePeriodModal);
    $('periodModal').addEventListener('click', (e) => {
      if (e.target.id === 'periodModal') closePeriodModal();
    });
    $('periodStartInput').addEventListener('change', updatePeriodPreview);
    $('periodStartInput').addEventListener('input', updatePeriodPreview);
    $('periodWeekCountSelect').addEventListener('change', updatePeriodPreview);
    $('btnPeriodThisWeek').addEventListener('click', () => {
      $('periodStartInput').value = currentMondayStr();
      updatePeriodPreview();
    });
    $('btnPeriodNextWeek').addEventListener('click', () => {
      $('periodStartInput').value = addDaysStr(currentMondayStr(), 7);
      updatePeriodPreview();
    });
    $('periodForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const { startDate, weekCount } = readPeriodForm();
      const delta = daysBetween(state.startDate, startDate);
      const shift = delta !== 0 && $('periodShiftSlots').checked;

      localEditSeq++;
      if (shift) {
        state.members.forEach(m => {
          m.slots = Array.from(new Set(m.slots.map(k => shiftSlotKey(k, delta))));
        });
        if (state.inspectedSlot) state.inspectedSlot = shiftSlotKey(state.inspectedSlot, delta);
      }
      state.highlightedSlots = [];
      state.startDate = startDate;
      state.weekCount = weekCount;
      state.viewWeek = Math.min(weekCount - 1, Math.max(0, state.viewWeek));
      saveState();
      renderAll();
      closePeriodModal();
      showToast(`합주 기간: ${formatMD(startDate)} ~ ${formatMD(periodEndStr(state))} (${weekCount}주)${shift ? ' · 입력된 시간도 함께 옮겼어요' : ''}`);

      const teamId = state.teamId;
      enqueueWrite(() => db.updateTeam(teamId, { start_date: startDate, week_count: weekCount }));
      if (shift) syncAllMembersSlots();
    });

    // --- 보기 모드 ---
    $('tabOverlap').addEventListener('click', () => {
      state.mode = 'overlap';
      saveState();
      renderAll();
    });

    $('tabEdit').addEventListener('click', switchToMyEdit);

    $('recScopeAll').addEventListener('click', () => {
      state.recScope = 'all';
      saveState();
      renderRecommendations();
    });
    $('recScopeWeek').addEventListener('click', () => {
      state.recScope = 'week';
      saveState();
      renderRecommendations();
    });

    // --- 멤버 추가 ---
    $('addMemberForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const nameInput = $('newMemberName');
      const partSelect = $('newMemberPart');
      const name = cleanName(nameInput.value, 16);
      if (!name) {
        showToast('추가할 멤버 이름을 입력해주세요.');
        nameInput.focus();
        return;
      }
      const used = new Set(state.members.map(m => m.colorIdx));
      let colorIdx = state.members.length % MEMBER_COLORS.length;
      for (let i = 0; i < MEMBER_COLORS.length; i++) {
        if (!used.has(i)) {
          colorIdx = i;
          break;
        }
      }
      const newMember = {
        id: uuid(),
        name,
        part: normalizePart(partSelect.value),
        colorIdx,
        sortOrder: state.members.reduce((mx, m) => Math.max(mx, m.sortOrder), -1) + 1,
        createdAt: new Date().toISOString(),
        included: true,
        slots: []
      };
      state.members.push(newMember);
      state.activeMemberId = newMember.id;
      state.mode = 'edit';
      state.highlightedSlots = [];
      nameInput.value = '';
      localEditSeq++;
      saveState();
      const teamId = state.teamId;
      enqueueWrite(() => db.insertMembers([{
        id: newMember.id,
        team_id: teamId,
        name: newMember.name,
        part: newMember.part,
        color_idx: newMember.colorIdx,
        sort_order: newMember.sortOrder,
        slots: []
      }]));
      renderAll();
      showToast(`'${name}' 멤버를 추가했습니다. 시간을 선택해보세요!`);
    });

    // --- 시간대 · 최소 인원 ---
    $('startHourSelect').addEventListener('change', (e) => {
      const val = parseInt(e.target.value, 10);
      state.startHour = val;
      if (state.endHour <= val) {
        state.endHour = Math.min(24, val + 1);
      }
      saveState();
      renderAll();
    });

    $('endHourSelect').addEventListener('change', (e) => {
      state.endHour = parseInt(e.target.value, 10);
      saveState();
      renderAll();
    });

    $('minMembersFilter').addEventListener('change', (e) => {
      state.minMembers = parseInt(e.target.value, 10);
      saveState();
      renderRecommendations();
    });

    // --- 단톡방용 결과 복사 (주차별 정리) ---
    $('btnCopySummary').addEventListener('click', () => {
      const included = getIncludedMembers();
      if (included.length === 0) {
        showToast('비교할 멤버가 없습니다.');
        return;
      }
      const byWeek = computeRecommendationsByWeek();
      if (byWeek.every(g => g.blocks.length === 0)) {
        showToast('복사할 겹치는 시간대가 없습니다.');
        return;
      }
      // 이미 지난 주차는 빼고 정리 (전부 지났으면 전체 포함)
      let groups = byWeek.filter(g => !isPastWeek(g.weekIdx));
      if (groups.length === 0) groups = byWeek;

      const lines = [`[${teamMeta.name} 합주 가능 시간] 비교 인원 ${included.length}명 · ${state.weekCount}주 (${formatMD(state.startDate)}~${formatMD(periodEndStr(state))})`];
      groups.forEach(g => {
        lines.push('');
        lines.push(`■ ${g.weekIdx + 1}주차 (${weekRangeText(g.weekIdx)})`);
        if (g.blocks.length === 0) {
          lines.push('  - 조건에 맞는 시간 없음');
          return;
        }
        g.blocks.slice(0, 3).forEach((b, idx) => {
          const missing = included.filter(m => !b.members.some(x => x.id === m.id)).map(m => m.name);
          const tag = b.count === b.total ? `★전원 ${b.count}명` : `${b.count}/${b.total}명 · 불참: ${missing.join(', ')}`;
          lines.push(`  ${idx + 1}. ${formatDateLabel(b.dateStr)} ${formatHour(b.startHour)}~${formatHour(b.endHour)} (${b.endHour - b.startHour}시간) [${tag}]`);
        });
      });
      lines.push('');
      lines.push(`입력하러 가기: ${teamLinkUrl()}`);
      copyText(lines.join('\n'), '주차별 합주 추천 시간 요약을 복사했습니다!');
    });

    // --- 시간 비우기 ---
    $('btnOpenResetModal').addEventListener('click', openResetModal);
    $('btnCancelReset').addEventListener('click', closeResetModal);
    $('resetModal').addEventListener('click', (e) => {
      if (e.target.id === 'resetModal') closeResetModal();
    });
    $('btnClearWeekSlots').addEventListener('click', () => {
      const dateSet = new Set(getWeekDates(state.viewWeek));
      state.members.forEach(m => {
        m.slots = m.slots.filter(k => {
          const p = parseSlotKey(k);
          return !p || !dateSet.has(p.date);
        });
      });
      state.highlightedSlots = [];
      saveState();
      syncAllMembersSlots();
      renderAll();
      closeResetModal();
      showToast(`${state.viewWeek + 1}주차 시간을 모두 비웠습니다.`);
    });
    $('btnClearAllSlots').addEventListener('click', () => {
      if (!window.confirm(`'${teamMeta.name}' 팀 모든 멤버의 모든 주차 시간을 지울까요? 되돌릴 수 없어요.`)) return;
      state.members.forEach(m => { m.slots = []; });
      state.highlightedSlots = [];
      saveState();
      syncAllMembersSlots();
      renderAll();
      closeResetModal();
      showToast('모든 주차 · 모든 멤버의 선택 시간을 비웠습니다.');
    });

    // --- 멤버 이름 수정 ---
    $('btnCancelRename').addEventListener('click', closeRenameModal);
    $('renameModal').addEventListener('click', (e) => {
      if (e.target.id === 'renameModal') closeRenameModal();
    });
    $('renameForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const m = state.members.find(x => x.id === renameTargetId);
      const newName = cleanName($('renameInput').value, 16);
      if (m && newName) {
        m.name = newName;
        m.part = normalizePart($('renamePartSelect').value);
        saveState();
        scheduleMemberSync(m);
        renderAll();
        closeRenameModal();
        showToast('멤버 정보를 수정했습니다.');
      }
    });

    // Esc 로 모달 닫기
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      ['renameModal', 'resetModal', 'periodModal', 'teamEditModal'].forEach(id => {
        if (!$(id).classList.contains('hidden')) hideModal(id);
      });
      if (!$('adminModal').classList.contains('hidden')) closeAdmin();
    });
  }

  // ===========================================================================
  // 시작
  // ===========================================================================
  function parseHashTeamId() {
    const m = /[#&]t=([0-9a-fA-F-]{36})/.exec(window.location.hash || '');
    return m && isUuid(m[1]) ? m[1].toLowerCase() : null;
  }

  function cleanupObsolete() {
    OBSOLETE_KEYS.forEach(k => removeKey(localStorage, k));
    const hash = window.location.hash || '';
    if (/[#&](gh|team)=/.test(hash)) {
      // 예전 버전 초대 링크(토큰 포함)는 주소창에서 바로 지웁니다.
      try {
        history.replaceState(null, '', window.location.pathname + window.location.search);
      } catch (e) {}
      return true;
    }
    return false;
  }

  function showSetupScreen(message) {
    if (message) $('setupScreenMessage').textContent = message;
    $('setupScreen').classList.remove('hidden');
  }

  function boot() {
    const fromOldLink = cleanupObsolete();
    bindEvents();

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      showSetupScreen();
      return;
    }
    if (!window.supabase || typeof window.supabase.createClient !== 'function') {
      showSetupScreen('서버 연결 라이브러리를 불러오지 못했어요. 인터넷 연결을 확인하고 새로고침해주세요.');
      return;
    }
    sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
    });

    if (fromOldLink) {
      setTimeout(() => showToast('예전 초대 링크예요. 이제는 밴드부와 팀을 골라서 들어오면 돼요.'), 300);
    }

    const linkTeamId = parseHashTeamId();
    const targetTeamId = linkTeamId || session.teamId;
    if (!targetTeamId) {
      openOnboarding(session.clubId ? 'team' : 'club', { clubId: session.clubId });
      return;
    }

    // 지난번 보던 팀을 이 기기에 저장된 내용으로 먼저 보여주고, 서버에서 최신으로 바꿉니다.
    const prefs = readJson(localStorage, UI_PREFIX + targetTeamId);
    const meId = session.me[targetTeamId];
    const cached = prefs && prefs.cache && prefs.cache.team && prefs.cache.team.id === targetTeamId ? prefs.cache : null;
    const cachedMembers = cached && Array.isArray(cached.members) ? cached.members : null;
    const rememberedHere = cachedMembers && (cachedMembers.some(m => m.id === meId) || (!linkTeamId && session.teamId === targetTeamId));
    if (cached && rememberedHere) {
      enterTeam(cached.team, cached.members);
      lastSyncTime = null;
      db.listClubs().then(rows => {
        clubs = rows || [];
        if (state) renderHeader();
      }).catch(() => {});
      refreshTeam(true).then(ok => {
        if (!ok && state && !lastSyncTime) renderStatus();
      });
      return;
    }
    openOnboarding('me', { teamId: targetTeamId, autoEnter: true });
  }

  boot();
})();
