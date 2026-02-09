/**
 * TestLink idle warning modal (vanilla JS) with cross-tab coordination.
 *
 * Goals:
 * - Only one "leader" tab performs periodic ajaxcheck polling and keepalive network calls.
 * - All tabs mirror modal state consistently (warn/close/expired redirect).
 * - Resist background-tab throttling: visibility-aware cadence + drift correction + resync on visible.
 *
 * Coordination channel:
 * - BroadcastChannel (preferred) named 'tl-idle-sync'
 * - localStorage event fallback (same message payloads)
 *
 * Broadcast events:
 *  {type:'heartbeat', lastActivity, leaderId}
 *  {type:'warn', warnAt}
 *  {type:'expired'}
 *  {type:'keepalive_ok', nextWarnAt}
 *  {type:'config', timeoutSeconds}
 *  {type:'request_lead'}
 *  {type:'keepalive_request', fromTabId}
 *
 * NOTE: This script should not be included on login pages; inc_head.tpl already ensures that.
 */
(function () {
  'use strict';

  // Avoid double-init (e.g., if included twice by accident).
  if (window.__TL_IDLE_WARNING_INITIALIZED__) {
    return;
  }
  window.__TL_IDLE_WARNING_INITIALIZED__ = true;

  /**
   * Debug flag.
   * - Default false.
   * - Can be enabled via window.TL_IDLE_DEBUG = true.
   * - Also supports localStorage override: localStorage.TL_IDLE_DEBUG="1"
   */
  var TL_IDLE_DEBUG = !!window.TL_IDLE_DEBUG;
  try {
    if (localStorage && localStorage.getItem('TL_IDLE_DEBUG') === '1') {
      TL_IDLE_DEBUG = true;
    }
  } catch (e) { /* ignore */ }

  function dbg() {
    if (!TL_IDLE_DEBUG || !window.console || !console.debug) return;
    try {
      console.debug.apply(console, ['[TL idle-sync]'].concat([].slice.call(arguments)));
    } catch (e) { /* ignore */ }
  }

  /**
   * Best-effort base href discovery (TestLink already sets <base href="..."> in inc_head.tpl).
   */
  function getBaseHref() {
    var baseEl = document.querySelector('base');
    if (baseEl && baseEl.href) {
      return baseEl.href;
    }
    // Fallback: derive from location (keeps trailing slash).
    var path = window.location.pathname || '/';
    return window.location.origin + path.substring(0, path.lastIndexOf('/') + 1);
  }

  var baseHref = getBaseHref();

  // PUBLIC_INTERFACE
  function getIdleConfig() {
    /** Returns effective TL idle config, using defaults and optional window.TL_IDLE_CONFIG overrides. */
    var defaults = {
      checkIntervalMs: 60000, // 60s (leader cadence when visible)
      // Safe default fallback if server doesn't tell us the timeout (30 minutes).
      sessionInactivityTimeoutSec: 30 * 60,
      ajaxCheckUrl: baseHref + 'login.php?do=ajaxcheck',
      keepAliveUrl: baseHref + 'lib/ajax/session_keepalive.php',
      redirectOnExpireUrl: baseHref + 'login.php?note=expired',
      warningLeadSeconds: 120
    };

    var cfg = window.TL_IDLE_CONFIG || {};
    return {
      checkIntervalMs: (typeof cfg.checkIntervalMs === 'number' && cfg.checkIntervalMs > 0)
        ? cfg.checkIntervalMs
        : defaults.checkIntervalMs,
      sessionInactivityTimeoutSec: (typeof cfg.sessionInactivityTimeoutSec === 'number' && cfg.sessionInactivityTimeoutSec > 0)
        ? cfg.sessionInactivityTimeoutSec
        : defaults.sessionInactivityTimeoutSec,
      ajaxCheckUrl: (typeof cfg.ajaxCheckUrl === 'string' && cfg.ajaxCheckUrl.length)
        ? cfg.ajaxCheckUrl
        : defaults.ajaxCheckUrl,
      keepAliveUrl: (typeof cfg.keepAliveUrl === 'string' && cfg.keepAliveUrl.length)
        ? cfg.keepAliveUrl
        : defaults.keepAliveUrl,
      redirectOnExpireUrl: (typeof cfg.redirectOnExpireUrl === 'string' && cfg.redirectOnExpireUrl.length)
        ? cfg.redirectOnExpireUrl
        : defaults.redirectOnExpireUrl,
      warningLeadSeconds: (typeof cfg.warningLeadSeconds === 'number' && cfg.warningLeadSeconds > 0)
        ? Math.floor(cfg.warningLeadSeconds)
        : defaults.warningLeadSeconds
    };
  }

  var CONFIG = getIdleConfig();

  // ========= Cross-tab coordination =========

  var CHANNEL_NAME = 'tl-idle-sync';
  var LS_MSG_KEY = 'tl_idle_sync_msg';

  /**
   * Leadership lease stored in localStorage.
   * IMPORTANT: localStorage doesn't offer a true atomic compare-and-swap, so we:
   *  - claim by writing {leaderId, leaseUntil, claimedAt, nonce}
   *  - then immediately read back and only accept leadership if we still match
   *  - add jitter to renew/poll to avoid lockstep racing
   *  - enforce "freshest lease wins" on storage events
   */
  var LS_LEADER_KEY = 'tl_idle_leader_lease';

  var TAB_ID = (function makeTabId() {
    // Small, unique enough, and stable for this tab lifetime.
    return 'tab_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
  })();

  // Lease timings
  var LEASE_MS = 45000;           // short TTL
  var LEASE_RENEW_BASE_MS = 15000; // renew frequently
  var LEASE_SKEW_MS = 2000;       // skew tolerance
  var CLAIM_BACKOFF_MAX_MS = 800; // follower backoff after failed claim

  // Broadcast debouncing (prevents re-entrancy storms when multiple events arrive quickly)
  var BC_DEBOUNCE_MS = 80;

  // Visibility-aware cadence (leader only)
  var HIDDEN_CADENCE_MS = 45000; // 30–60s requested; choose 45s
  var DRIFT_THRESHOLD_MS = 15000;

  // Circuit breaker: if two consecutive polls are detected too close together, force re-election
  var POLL_MIN_GAP_MS = 800;

  // Timer bookkeeping (leader only)
  var leaderState = {
    isLeader: false,
    leaseRenewTimer: null,
    tickTimer: null,
    nextTickPlannedAt: null,
    lastTickAt: 0,
    lastAjaxCheckAt: 0,
    lastPoll1At: 0,
    lastPoll2At: 0,
    leaderNonce: null,
    isDoingAjaxCheck: false,
    isDoingKeepalive: false
  };

  // follower-side claim backoff
  var followerState = {
    nextAllowedClaimAt: 0
  };

  // Shared "truth" for UI mirroring across tabs
  var sharedState = {
    lastActivityAt: Date.now(),
    warningShown: false,
    // warnAt is when warning modal should appear
    warnAt: null,
    // deadlineAt is UX countdown target (usually warnAt + warningLeadSeconds)
    deadlineAt: null,
    effectiveSessionTimeoutSec: CONFIG.sessionInactivityTimeoutSec
  };

  // Best-effort channel abstraction.
  var bc = null;

  function nowMs() { return Date.now(); }

  function jitterMs(maxMs) {
    return Math.floor(Math.random() * Math.max(0, maxMs || 0));
  }

  function parseJSON(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  function safeSetLocalStorage(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch (e) {
      return false;
    }
  }

  function safeGetLocalStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function debounce(fn, waitMs) {
    var t = null;
    var lastArgs = null;
    return function () {
      lastArgs = arguments;
      if (t) return;
      t = setTimeout(function () {
        t = null;
        try { fn.apply(null, lastArgs); } catch (e) { /* ignore */ }
        lastArgs = null;
      }, waitMs);
    };
  }

  var onIncomingMessageDebounced = debounce(onIncomingMessageImpl, BC_DEBOUNCE_MS);

  function postMessage(payload) {
    // Always add sender and timestamp so listeners can ignore their own messages if needed.
    payload = payload || {};
    payload.__from = TAB_ID;
    payload.__ts = nowMs();

    // BroadcastChannel
    if (bc) {
      try { bc.postMessage(payload); } catch (e) { /* ignore */ }
    }

    // localStorage fallback (also doubles as redundancy)
    // Use a random suffix to ensure storage event fires even if same payload occurs.
    safeSetLocalStorage(LS_MSG_KEY, JSON.stringify(payload) + '|' + Math.random().toString(36).slice(2));
  }

  function initChannel() {
    if ('BroadcastChannel' in window) {
      try {
        bc = new BroadcastChannel(CHANNEL_NAME);
        bc.onmessage = function (evt) {
          onIncomingMessageDebounced(evt.data);
        };
      } catch (e) {
        bc = null;
      }
    }

    window.addEventListener('storage', function (e) {
      if (!e) return;

      if (e.key === LS_MSG_KEY) {
        if (!e.newValue) return;
        // format: JSON|randomsuffix
        var idx = e.newValue.lastIndexOf('|');
        var raw = (idx === -1) ? e.newValue : e.newValue.slice(0, idx);
        var payload = parseJSON(raw);
        onIncomingMessageDebounced(payload);
        return;
      }

      if (e.key === LS_LEADER_KEY) {
        // lease changed: if we are not the freshest leader anymore, cancel leader timers immediately
        handleLeaseChangeEvent();
      }
    });
  }

  function readLease() {
    var raw = safeGetLocalStorage(LS_LEADER_KEY);
    if (!raw) return null;
    var data = parseJSON(raw);
    if (!data || typeof data !== 'object') return null;
    if (typeof data.leaderId !== 'string' || !data.leaderId) return null;
    if (typeof data.leaseUntil !== 'number' || !isFinite(data.leaseUntil)) return null;
    // optional fields: claimedAt, nonce
    if (typeof data.claimedAt !== 'number' || !isFinite(data.claimedAt)) {
      data.claimedAt = 0;
    }
    if (typeof data.nonce !== 'string') {
      data.nonce = null;
    }
    return data;
  }

  function writeLease(leaderId, leaseUntil, claimedAt, nonce) {
    return safeSetLocalStorage(LS_LEADER_KEY, JSON.stringify({
      leaderId: leaderId,
      leaseUntil: leaseUntil,
      claimedAt: claimedAt,
      nonce: nonce
    }));
  }

  function isLeaseValid(lease) {
    if (!lease) return false;
    return lease.leaseUntil > (nowMs() + LEASE_SKEW_MS);
  }

  function isOurLease(lease) {
    return !!lease && lease.leaderId === TAB_ID && (!leaderState.leaderNonce || lease.nonce === leaderState.leaderNonce);
  }

  function hasLeadership() {
    var lease = readLease();
    return isLeaseValid(lease) && isOurLease(lease);
  }

  function clearLeaderTimers() {
    if (leaderState.leaseRenewTimer) {
      clearTimeout(leaderState.leaseRenewTimer);
      leaderState.leaseRenewTimer = null;
    }
    if (leaderState.tickTimer) {
      clearTimeout(leaderState.tickTimer);
      leaderState.tickTimer = null;
    }
    leaderState.nextTickPlannedAt = null;
  }

  function scheduleLeaderTick(delayMs) {
    clearTimeout(leaderState.tickTimer);
    var d = Math.max(0, Math.floor(delayMs || 0));
    // add small jitter so multiple tabs won't wake in lockstep when leadership changes
    d = d + jitterMs(400);

    leaderState.nextTickPlannedAt = nowMs() + d;

    leaderState.tickTimer = setTimeout(function () {
      var wokeAt = nowMs();
      var plannedAt = leaderState.nextTickPlannedAt || wokeAt;
      var drift = wokeAt - plannedAt;

      // Drift correction: if we were throttled/slept too long, resync immediately.
      if (drift > DRIFT_THRESHOLD_MS) {
        dbg('drift', drift, 'ms -> immediate ajaxcheck');
        leaderMainTick(true);
      } else {
        leaderMainTick(false);
      }
    }, d);
  }

  function leaderCadenceMs() {
    return document.hidden ? HIDDEN_CADENCE_MS : CONFIG.checkIntervalMs;
  }

  function becomeLeader(reason) {
    if (leaderState.isLeader) return;
    leaderState.isLeader = true;
    dbg('BECOME LEADER', reason, 'tab=', TAB_ID, 'nonce=', leaderState.leaderNonce);

    // Start/renew lease and start tick loop.
    renewLeaseLoop();
    // Kick immediately to establish state.
    leaderMainTick(true);
  }

  function demoteLeader(reason) {
    if (!leaderState.isLeader) return;
    dbg('DEMOTE LEADER', reason, 'tab=', TAB_ID);
    leaderState.isLeader = false;
    leaderState.isDoingAjaxCheck = false;
    leaderState.isDoingKeepalive = false;
    clearLeaderTimers();
  }

  function renewLeaseLoop() {
    if (!leaderState.isLeader) return;

    // Always revalidate before renew; if we lost it, stop.
    if (!hasLeadership()) {
      demoteLeader('lease lost before renew');
      return;
    }

    var until = nowMs() + LEASE_MS;
    // renew with same nonce
    writeLease(TAB_ID, until, nowMs(), leaderState.leaderNonce);

    var renewIn = LEASE_RENEW_BASE_MS + jitterMs(600);
    leaderState.leaseRenewTimer = setTimeout(function () {
      // If we lost leadership, stop.
      if (!hasLeadership()) {
        demoteLeader('lease lost while renewing');
        return;
      }
      renewLeaseLoop();
    }, renewIn);
  }

  function tryBecomeLeader(reason) {
    var ts = nowMs();
    if (ts < followerState.nextAllowedClaimAt) {
      return false;
    }

    var lease = readLease();
    if (isLeaseValid(lease)) {
      // Someone else is leader
      if (lease.leaderId !== TAB_ID) {
        return false;
      }

      // Lease says we're leader: adopt nonce if missing locally
      leaderState.leaderNonce = lease.nonce || leaderState.leaderNonce;
      if (!leaderState.isLeader) {
        becomeLeader('lease says we are leader (' + reason + ')');
      }
      return true;
    }

    // No valid leader -> claim
    var nonce = 'n_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
    leaderState.leaderNonce = nonce;

    var claimedAt = nowMs();
    writeLease(TAB_ID, claimedAt + LEASE_MS, claimedAt, nonce);

    // Verify claim succeeded (race)
    var after = readLease();
    if (isLeaseValid(after) && after.leaderId === TAB_ID && after.nonce === nonce) {
      becomeLeader('claimed (' + reason + ')');
      return true;
    }

    // Failed; back off a bit to reduce thundering herd
    followerState.nextAllowedClaimAt = nowMs() + jitterMs(CLAIM_BACKOFF_MAX_MS);
    return false;
  }

  function handleLeaseChangeEvent() {
    var lease = readLease();
    if (!isLeaseValid(lease)) {
      // no leader currently; do nothing - monitor will try to claim
      if (leaderState.isLeader) {
        demoteLeader('lease storage event indicates no valid lease');
      }
      return;
    }

    if (leaderState.isLeader) {
      // If another tab has a valid, different lease (or our nonce changed), demote immediately.
      if (!isOurLease(lease)) {
        demoteLeader('storage event: fresher/different leader detected (' + lease.leaderId + ')');
      }
      return;
    }

    // follower: if we see a leader, ensure we are not running leader timers (should already be off)
    // (nothing to do beyond making sure)
    clearLeaderTimers();
  }

  function leaderMonitorLoop() {
    // Non-leader tabs periodically check if leader lease exists; if not, attempt to claim.
    // Leader tab also monitors to demote itself if lease lost.
    setInterval(function () {
      var lease = readLease();
      var valid = isLeaseValid(lease);

      if (leaderState.isLeader) {
        if (!valid || !isOurLease(lease)) {
          demoteLeader('monitor: another tab claimed leadership');
        }
        return;
      }

      if (!valid) {
        tryBecomeLeader('monitor');
      }
    }, 5000 + jitterMs(800));
  }

  // ========= Broadcast handling =========

  function onIncomingMessageImpl(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.__from && payload.__from === TAB_ID) return; // ignore our own

    if (TL_IDLE_DEBUG) {
      dbg('recv', payload);
    }

    switch (payload.type) {
      case 'heartbeat':
        if (typeof payload.lastActivity === 'number' && payload.lastActivity > 0) {
          sharedState.lastActivityAt = Math.max(sharedState.lastActivityAt, payload.lastActivity);
        }
        break;

      case 'config':
        if (typeof payload.timeoutSeconds === 'number' && payload.timeoutSeconds > 0) {
          sharedState.effectiveSessionTimeoutSec = Math.floor(payload.timeoutSeconds);
        }
        break;

      case 'warn':
        if (typeof payload.warnAt === 'number' && payload.warnAt > 0) {
          // Leader instructs all tabs to show warning (or keep it shown) using a consistent time base.
          sharedState.warnAt = payload.warnAt;
          sharedState.deadlineAt = payload.warnAt + (CONFIG.warningLeadSeconds * 1000);
          openModal(sharedState.deadlineAt);
        }
        break;

      case 'keepalive_ok':
        // All tabs close modal & treat as activity baseline refresh.
        if (typeof payload.nextWarnAt === 'number' && payload.nextWarnAt > 0) {
          sharedState.lastActivityAt = nowMs();
          sharedState.warnAt = payload.nextWarnAt;
          sharedState.deadlineAt = payload.nextWarnAt + (CONFIG.warningLeadSeconds * 1000);
        } else {
          sharedState.lastActivityAt = nowMs();
          sharedState.warnAt = null;
          sharedState.deadlineAt = null;
        }
        closeModal();
        break;

      case 'expired':
        redirectToExpired();
        break;

      case 'request_lead':
        // A tab asks for a visible tab to take leadership (e.g., leader is hidden).
        // If we're visible, attempt to become leader immediately.
        if (!document.hidden) {
          tryBecomeLeader('request_lead');
        }
        break;

      case 'keepalive_request':
        // Only the true leader should honor this; others ignore.
        // Guard again with lease check to prevent duplicate keepalive if leadership changed.
        if (leaderState.isLeader && hasLeadership()) {
          doKeepAliveLeader().catch(function () { /* handled inside */ });
        }
        break;

      default:
        break;
    }
  }

  // ========= Idle logic =========

  // Track user activity (local) and also broadcast heartbeat.
  var activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
  function markActivityLocal() {
    sharedState.lastActivityAt = nowMs();
    postMessage({
      type: 'heartbeat',
      lastActivity: sharedState.lastActivityAt,
      leaderId: (readLease() || {}).leaderId || null
    });
  }
  activityEvents.forEach(function (evt) {
    window.addEventListener(evt, markActivityLocal, { passive: true });
  });

  // Modal state
  var modalEl = null;
  var countdownIntervalId = null;
  var previouslyFocusedEl = null;

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function formatTimeLeft(ms) {
    var totalSec = Math.max(0, Math.floor(ms / 1000));
    var min = Math.floor(totalSec / 60);
    var sec = totalSec % 60;
    return min + ':' + pad2(sec);
  }

  /**
   * Derive the inactivity timeout from ajaxcheck payload if possible.
   *
   * Supported formats (best effort):
   * - data.sessionInactivityTimeoutSec (number)
   * - data.sessionInactivityTimeout (number, assumed seconds)
   * - data.timeoutSec (number)
   * - data.timeout (number, assumed seconds)
   */
  function extractTimeoutSecondsFromAjaxCheck(data) {
    if (!data || typeof data !== 'object') return null;

    var candidates = [
      'sessionInactivityTimeoutSec',
      'sessionInactivityTimeout',
      'timeoutSec',
      'timeout'
    ];

    for (var i = 0; i < candidates.length; i++) {
      var key = candidates[i];
      if (typeof data[key] === 'number' && isFinite(data[key]) && data[key] > 0) {
        return Math.floor(data[key]);
      }
      if (typeof data[key] === 'string' && data[key].trim() !== '') {
        var parsed = Number(data[key]);
        if (isFinite(parsed) && parsed > 0) {
          return Math.floor(parsed);
        }
      }
    }
    return null;
  }

  function getWarnOffsetMs() {
    var timeoutMs = (sharedState.effectiveSessionTimeoutSec || CONFIG.sessionInactivityTimeoutSec) * 1000;
    var warnOffset = timeoutMs - (CONFIG.warningLeadSeconds * 1000);
    return Math.max(1000, warnOffset);
  }

  function buildModal() {
    var wrapper = document.createElement('div');
    wrapper.id = 'tl-idle-warning';
    wrapper.innerHTML = '' +
      '<div class="tl-idle-backdrop" role="presentation"></div>' +
      '<div class="tl-idle-dialog" role="dialog" aria-modal="true" aria-labelledby="tl-idle-title" aria-describedby="tl-idle-desc">' +
        '<div class="tl-idle-header">' +
          '<div id="tl-idle-title" class="tl-idle-title">Session expiring</div>' +
        '</div>' +
        '<div class="tl-idle-body">' +
          '<div id="tl-idle-desc" class="tl-idle-text">Your session is about to expire due to inactivity.</div>' +
          '<div class="tl-idle-countdown">Time remaining: <span class="tl-idle-time" data-role="time">--:--</span></div>' +
          '<div class="tl-idle-status" data-role="status" aria-live="polite"></div>' +
        '</div>' +
        '<div class="tl-idle-footer">' +
          '<button type="button" class="tl-idle-btn tl-idle-btn-primary" data-role="stay">Stay signed in</button>' +
        '</div>' +
      '</div>';

    // Scoped CSS
    var style = document.createElement('style');
    style.type = 'text/css';
    style.textContent = '' +
      '#tl-idle-warning{display:none;position:fixed;inset:0;z-index:100000;}' +
      '#tl-idle-warning.tl-open{display:block;}' +
      '#tl-idle-warning .tl-idle-backdrop{position:absolute;inset:0;background:rgba(0,0,0,0.35);}' +
      '#tl-idle-warning .tl-idle-dialog{position:relative;max-width:520px;margin:12% auto 0 auto;background:#fff;' +
        'border:1px solid #666;border-radius:4px;box-shadow:0 6px 18px rgba(0,0,0,0.35);font-family:Arial, Helvetica, sans-serif;}' +
      '#tl-idle-warning .tl-idle-header{padding:10px 12px;border-bottom:1px solid #ccc;background:#f2f2f2;}' +
      '#tl-idle-warning .tl-idle-title{font-weight:bold;color:#333;font-size:14px;}' +
      '#tl-idle-warning .tl-idle-body{padding:12px;color:#222;font-size:13px;}' +
      '#tl-idle-warning .tl-idle-countdown{margin-top:8px;font-weight:bold;}' +
      '#tl-idle-warning .tl-idle-status{margin-top:10px;min-height:16px;color:#555;font-size:12px;}' +
      '#tl-idle-warning .tl-idle-footer{padding:10px 12px;border-top:1px solid #ccc;background:#f9f9f9;text-align:right;}' +
      '#tl-idle-warning .tl-idle-btn{padding:6px 12px;border:1px solid #777;border-radius:3px;background:#efefef;cursor:pointer;font-size:12px;}' +
      '#tl-idle-warning .tl-idle-btn:disabled{opacity:0.6;cursor:not-allowed;}' +
      '#tl-idle-warning .tl-idle-btn-primary{background:#0099CC;border-color:#007aa3;color:#fff;font-weight:bold;}';

    document.head.appendChild(style);
    document.body.appendChild(wrapper);

    return wrapper;
  }

  function ensureModal() {
    if (modalEl) return;

    modalEl = buildModal();
    var stayBtn = modalEl.querySelector('[data-role="stay"]');

    // Clicking "Stay signed in" should never duplicate network calls:
    // - If we are leader AND still hold lease: do keepalive.
    // - If not leader: forward to leader. If leader is hidden/throttled, request a visible leader.
    stayBtn.addEventListener('click', function () {
      // UX: disable quickly in this tab; we'll re-enable when modal closes or on failure message.
      stayBtn.disabled = true;
      setModalStatus('Keeping you signed in...');

      if (leaderState.isLeader && hasLeadership()) {
        doKeepAliveLeader().finally(function () {
          // If modal remains open due to failure, re-enable.
          if (modalEl && modalEl.classList.contains('tl-open')) stayBtn.disabled = false;
        });
        return;
      }

      // Force immediate revalidation and leadership request
      postMessage({ type: 'request_lead' });

      // Forward keepalive request to leader; all tabs will close on keepalive_ok.
      postMessage({ type: 'keepalive_request', fromTabId: TAB_ID });

      // If nothing happens quickly, show a helpful message and re-enable.
      setTimeout(function () {
        if (modalEl && modalEl.classList.contains('tl-open')) {
          setModalStatus('Attempting to refresh session in another tab...');
          stayBtn.disabled = false;
        }
      }, 4000);
    });

    // Basic focus trap
    modalEl.addEventListener('focusin', function (e) {
      if (!modalEl.classList.contains('tl-open')) return;
      var dialog = modalEl.querySelector('.tl-idle-dialog');
      if (dialog && !dialog.contains(e.target)) {
        try { stayBtn.focus(); } catch (err) { /* ignore */ }
      }
    });
  }

  function setModalStatus(msg) {
    if (!modalEl) return;
    var statusEl = modalEl.querySelector('[data-role="status"]');
    if (statusEl) statusEl.textContent = msg || '';
  }

  function startCountdown(deadlineAt) {
    stopCountdown();
    updateCountdown(deadlineAt);
    countdownIntervalId = window.setInterval(function () {
      updateCountdown(deadlineAt);
    }, 1000);
  }

  function stopCountdown() {
    if (countdownIntervalId) {
      window.clearInterval(countdownIntervalId);
      countdownIntervalId = null;
    }
  }

  function updateCountdown(deadlineAt) {
    if (!modalEl || !deadlineAt) return;
    var msLeft = deadlineAt - nowMs();

    var timeEl = modalEl.querySelector('[data-role="time"]');
    if (timeEl) timeEl.textContent = formatTimeLeft(msLeft);

    if (msLeft <= 0) {
      // Leader should have already expired, but make UX consistent across tabs.
      redirectToExpired();
    }
  }

  function redirectToExpired() {
    window.location.href = CONFIG.redirectOnExpireUrl;
  }

  function openModal(deadlineAt) {
    ensureModal();

    if (!modalEl.classList.contains('tl-open')) {
      try { previouslyFocusedEl = document.activeElement; } catch (e) { previouslyFocusedEl = null; }
    }

    modalEl.classList.add('tl-open');
    setModalStatus('');
    startCountdown(deadlineAt);

    var stayBtn = modalEl.querySelector('[data-role="stay"]');
    if (stayBtn) {
      stayBtn.disabled = false;
      window.setTimeout(function () {
        try { stayBtn.focus(); } catch (e) { /* ignore */ }
      }, 0);
    }
  }

  function restoreFocus() {
    if (!previouslyFocusedEl) return;
    if (!document.contains(previouslyFocusedEl)) return;
    try { previouslyFocusedEl.focus(); } catch (e) { /* ignore */ }
  }

  function closeModal() {
    if (!modalEl) return;
    if (!modalEl.classList.contains('tl-open')) return;
    modalEl.classList.remove('tl-open');
    stopCountdown();
    setModalStatus('');
    restoreFocus();
    previouslyFocusedEl = null;
  }

  function circuitBreakerBeforePoll() {
    var ts = nowMs();
    leaderState.lastPoll2At = leaderState.lastPoll1At;
    leaderState.lastPoll1At = ts;

    if (leaderState.lastPoll2At && (leaderState.lastPoll1At - leaderState.lastPoll2At) < POLL_MIN_GAP_MS) {
      dbg('CIRCUIT BREAKER: two polls within', (leaderState.lastPoll1At - leaderState.lastPoll2At), 'ms -> force re-election');
      forceReelection('circuit-breaker');
      return false;
    }
    return true;
  }

  function forceReelection(reason) {
    // Demote self and clear lease so someone can reclaim cleanly.
    demoteLeader('forceReelection:' + reason);
    try {
      safeSetLocalStorage(LS_LEADER_KEY, '');
      localStorage.removeItem(LS_LEADER_KEY);
    } catch (e) { /* ignore */ }
    // Backoff before trying to claim again
    followerState.nextAllowedClaimAt = nowMs() + 300 + jitterMs(700);
  }

  function ajaxCheckSessionLeader() {
    // Revalidate leadership before network call
    if (!leaderState.isLeader || !hasLeadership()) {
      demoteLeader('ajaxcheck: not leader/lease lost');
      return Promise.resolve(null);
    }
    if (leaderState.isDoingAjaxCheck) {
      // prevent concurrent ajaxcheck from same leader due to re-entrancy
      return Promise.resolve(null);
    }

    if (!circuitBreakerBeforePoll()) {
      return Promise.resolve(null);
    }

    leaderState.isDoingAjaxCheck = true;
    leaderState.lastAjaxCheckAt = nowMs();

    dbg('ajaxcheck ->', CONFIG.ajaxCheckUrl);

    return fetch(CONFIG.ajaxCheckUrl, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (resp) {
        if (!resp.ok) {
          throw new Error('ajaxcheck http ' + resp.status);
        }
        return resp.text();
      })
      .then(function (body) {
        var data = parseJSON(body);
        if (!data || typeof data.validSession !== 'boolean') {
          throw new Error('ajaxcheck invalid json');
        }

        if (!data.validSession) {
          postMessage({ type: 'expired' });
          redirectToExpired();
          return null;
        }

        var derived = extractTimeoutSecondsFromAjaxCheck(data);
        if (typeof derived === 'number' && derived > 0) {
          sharedState.effectiveSessionTimeoutSec = derived;
        } else {
          sharedState.effectiveSessionTimeoutSec = CONFIG.sessionInactivityTimeoutSec;
        }

        // Broadcast effective timeout so all tabs use consistent warn offset.
        postMessage({ type: 'config', timeoutSeconds: sharedState.effectiveSessionTimeoutSec });

        return data;
      })
      .catch(function (err) {
        dbg('ajaxcheck failed', err && err.message ? err.message : err);
        return null;
      })
      .finally(function () {
        leaderState.isDoingAjaxCheck = false;
      });
  }

  function computeWarnAtFromActivity() {
    return sharedState.lastActivityAt + getWarnOffsetMs();
  }

  function leaderMainTick(forceImmediateAjaxCheck) {
    if (!leaderState.isLeader) return;

    // Before each tick, revalidate leadership and back off if not leader.
    if (!hasLeadership()) {
      demoteLeader('lost lease before tick');
      return;
    }

    var ts = nowMs();
    leaderState.lastTickAt = ts;

    // Keep other tabs updated with activity baseline.
    postMessage({ type: 'heartbeat', lastActivity: sharedState.lastActivityAt, leaderId: TAB_ID });

    // Decide whether to ajaxcheck now:
    // - forced by drift correction or on visible transition
    // - or while warning shown and visible
    var doAjax = !!forceImmediateAjaxCheck;

    // Always re-evaluate warning state based on local idle.
    var warnAt = computeWarnAtFromActivity();

    // If warning time reached, broadcast warn and show locally.
    if (ts >= warnAt) {
      sharedState.warnAt = warnAt;
      sharedState.deadlineAt = warnAt + (CONFIG.warningLeadSeconds * 1000);

      postMessage({ type: 'warn', warnAt: warnAt });
      openModal(sharedState.deadlineAt);

      // While warning shown, check session more aggressively on leader when visible to avoid stale state.
      if (!document.hidden) {
        doAjax = true;
      }
    } else {
      // If we are before warnAt, ensure modal is closed locally.
      closeModal();
    }

    var ajaxPromise = Promise.resolve();
    if (doAjax) {
      ajaxPromise = ajaxCheckSessionLeader();
    }

    ajaxPromise.finally(function () {
      // Leadership might have changed during async work.
      if (!leaderState.isLeader || !hasLeadership()) {
        demoteLeader('lost lease after async work');
        return;
      }

      var interval = leaderCadenceMs();
      scheduleLeaderTick(interval);
    });
  }

  function doKeepAliveLeader() {
    // Ensure leader and lease are valid before sending keepalive.
    if (!leaderState.isLeader || !hasLeadership()) {
      demoteLeader('keepalive: not leader/lease lost');
      return Promise.resolve(null);
    }
    if (leaderState.isDoingKeepalive) {
      return Promise.resolve(null);
    }

    leaderState.isDoingKeepalive = true;

    ensureModal();
    setModalStatus('Keeping you signed in...');

    dbg('keepalive ->', CONFIG.keepAliveUrl);

    return fetch(CONFIG.keepAliveUrl, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Accept': 'application/json' }
    })
      .then(function (resp) {
        if (resp.status === 401) {
          return resp.json().catch(function () { return { ok: false }; });
        }
        if (!resp.ok) {
          throw new Error('keepalive http ' + resp.status);
        }
        return resp.json().catch(function () {
          throw new Error('keepalive invalid json');
        });
      })
      .then(function (data) {
        if (!data || data.ok !== true) {
          postMessage({ type: 'expired' });
          redirectToExpired();
          return null;
        }

        // Treat keepalive as activity reset.
        sharedState.lastActivityAt = nowMs();
        sharedState.warnAt = computeWarnAtFromActivity();
        sharedState.deadlineAt = sharedState.warnAt + (CONFIG.warningLeadSeconds * 1000);

        // Close modal everywhere; other tabs will close on keepalive_ok.
        postMessage({ type: 'keepalive_ok', nextWarnAt: sharedState.warnAt });
        closeModal();

        // Immediately ajaxcheck to align timeout changes and confirm validity.
        return ajaxCheckSessionLeader();
      })
      .catch(function () {
        // Keep modal open with failure status in leader; other tabs remain waiting.
        setModalStatus('Unable to refresh session. Please save your work.');
        return null;
      })
      .finally(function () {
        leaderState.isDoingKeepalive = false;
      });
  }

  // ========= Visibility handling =========

  function revalidateLeadershipImmediate(reason) {
    // Any visible tab should attempt to claim leadership if lease is expired.
    // Any leader should revalidate and potentially demote.
    if (leaderState.isLeader) {
      if (!hasLeadership()) {
        demoteLeader('visibility revalidate: lost lease (' + reason + ')');
      } else {
        // On visible, do an immediate tick to sync state quickly.
        leaderMainTick(true);
      }
      return;
    }

    // follower
    tryBecomeLeader('visibility:' + reason);
    // Even if we didn't become leader, request visible leadership takeover to avoid a hidden leader being stuck.
    postMessage({ type: 'request_lead' });
  }

  function onVisibilityChange() {
    // Visibility change forces immediate revalidation.
    revalidateLeadershipImmediate('visibilitychange');
  }

  // ========= Startup =========

  function start() {
    // Defensive: do not run on login.php itself even if accidentally included.
    var path = (window.location.pathname || '').toLowerCase();
    if (path.indexOf('login.php') !== -1) {
      return;
    }

    CONFIG = getIdleConfig();
    initChannel();
    ensureModal();

    // Initial activity baseline: broadcast so leader has something sane.
    postMessage({ type: 'heartbeat', lastActivity: sharedState.lastActivityAt, leaderId: null });

    // Try to become leader at startup if no valid lease.
    tryBecomeLeader('startup');

    // Monitor loop keeps leadership stable and handles race conditions.
    leaderMonitorLoop();

    // Visibility change handling
    document.addEventListener('visibilitychange', onVisibilityChange);

    // When page becomes visible, do an immediate coordination tick.
    if (!document.hidden) {
      revalidateLeadershipImmediate('startup-visible');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
