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

  /** Lightweight debug flag. Default false. Can be overridden by window.TL_IDLE_DEBUG = true; */
  var TL_IDLE_DEBUG = !!window.TL_IDLE_DEBUG;

  function dbg() {
    if (!TL_IDLE_DEBUG || !window.console || !console.log) return;
    try {
      console.log.apply(console, ['[TL idle-sync]'].concat([].slice.call(arguments)));
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
  var LS_LEADER_KEY = 'tl_idle_leader_lease';
  var TAB_ID = (function makeTabId() {
    // Small, unique enough, and stable for this tab lifetime.
    return 'tab_' + Math.random().toString(36).slice(2) + '_' + Date.now().toString(36);
  })();

  // Lease: renewable leadership so only one tab polls/keepalive.
  var LEASE_MS = 65000;         // lease duration ~65s
  var LEASE_RENEW_MS = 25000;   // renew every 25s
  var LEASE_SKEW_MS = 2000;     // skew tolerance

  // Visibility-aware cadence (leader only)
  var HIDDEN_CADENCE_MS = 45000; // 30–60s requested; pick 45s
  var DRIFT_THRESHOLD_MS = 15000;

  // Timer bookkeeping (leader only)
  var leaderState = {
    isLeader: false,
    leaseRenewTimer: null,
    tickTimer: null,
    nextTickPlannedAt: null,
    lastTickAt: 0,
    lastAjaxCheckAt: 0
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

  function postMessage(payload) {
    // Always add sender and timestamp so listeners can ignore their own messages if needed.
    payload = payload || {};
    payload.__from = TAB_ID;
    payload.__ts = nowMs();

    dbg('send', payload);

    // BroadcastChannel
    if (bc) {
      try { bc.postMessage(payload); } catch (e) { /* ignore */ }
    }

    // localStorage fallback (also doubles as redundancy)
    // Use a random suffix to ensure storage event fires even if same payload occurs.
    safeSetLocalStorage(LS_MSG_KEY, JSON.stringify(payload) + '|' + Math.random().toString(36).slice(2));
  }

  function onIncomingMessage(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.__from && payload.__from === TAB_ID) return; // ignore our own

    dbg('recv', payload);

    switch (payload.type) {
      case 'heartbeat':
        if (typeof payload.lastActivity === 'number' && payload.lastActivity > 0) {
          sharedState.lastActivityAt = Math.max(sharedState.lastActivityAt, payload.lastActivity);
        }
        // Mirror leader's warn scheduling if provided via warn event separately.
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
        // Only leader should honor this; others ignore.
        if (leaderState.isLeader) {
          doKeepAliveLeader().catch(function () { /* handled inside */ });
        }
        break;

      default:
        break;
    }
  }

  function initChannel() {
    if ('BroadcastChannel' in window) {
      try {
        bc = new BroadcastChannel(CHANNEL_NAME);
        bc.onmessage = function (evt) {
          onIncomingMessage(evt.data);
        };
      } catch (e) {
        bc = null;
      }
    }

    window.addEventListener('storage', function (e) {
      if (!e) return;
      if (e.key !== LS_MSG_KEY) return;
      if (!e.newValue) return;
      // format: JSON|randomsuffix
      var idx = e.newValue.lastIndexOf('|');
      var raw = (idx === -1) ? e.newValue : e.newValue.slice(0, idx);
      var payload = parseJSON(raw);
      onIncomingMessage(payload);
    });
  }

  function readLease() {
    var raw = safeGetLocalStorage(LS_LEADER_KEY);
    if (!raw) return null;
    var data = parseJSON(raw);
    if (!data || typeof data !== 'object') return null;
    if (typeof data.leaderId !== 'string' || !data.leaderId) return null;
    if (typeof data.leaseUntil !== 'number' || !isFinite(data.leaseUntil)) return null;
    return data;
  }

  function writeLease(leaderId, leaseUntil) {
    return safeSetLocalStorage(LS_LEADER_KEY, JSON.stringify({
      leaderId: leaderId,
      leaseUntil: leaseUntil
    }));
  }

  function isLeaseValid(lease) {
    if (!lease) return false;
    return lease.leaseUntil > (nowMs() + LEASE_SKEW_MS);
  }

  function hasLeadership() {
    var lease = readLease();
    return isLeaseValid(lease) && lease.leaderId === TAB_ID;
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
    dbg('BECOME LEADER', reason);

    // Start/renew lease and start tick loop.
    renewLeaseLoop();
    // Kick immediately to establish state.
    leaderMainTick(true);
  }

  function demoteLeader(reason) {
    if (!leaderState.isLeader) return;
    dbg('DEMOTE LEADER', reason);
    leaderState.isLeader = false;
    clearLeaderTimers();
  }

  function renewLeaseLoop() {
    if (!leaderState.isLeader) return;

    var until = nowMs() + LEASE_MS;
    writeLease(TAB_ID, until);

    leaderState.leaseRenewTimer = setTimeout(function () {
      // If we lost leadership, stop.
      if (!hasLeadership()) {
        demoteLeader('lease lost while renewing');
        return;
      }
      renewLeaseLoop();
    }, LEASE_RENEW_MS);
  }

  function tryBecomeLeader(reason) {
    var lease = readLease();
    if (isLeaseValid(lease)) {
      // Someone else is leader
      if (lease.leaderId !== TAB_ID) {
        return false;
      }
      // Lease says we're leader: ensure our leader loop is running
      if (!leaderState.isLeader) {
        becomeLeader('lease says we are leader (' + reason + ')');
      }
      return true;
    }

    // No valid leader -> claim
    writeLease(TAB_ID, nowMs() + LEASE_MS);
    // Verify claim succeeded (race)
    if (hasLeadership()) {
      becomeLeader('claimed (' + reason + ')');
      return true;
    }
    return false;
  }

  function leaderMonitorLoop() {
    // Non-leader tabs periodically check if leader lease exists; if not, attempt to claim.
    // Leader tab also monitors to demote itself if lease lost.
    setInterval(function () {
      var lease = readLease();
      var valid = isLeaseValid(lease);

      if (leaderState.isLeader) {
        if (!valid || lease.leaderId !== TAB_ID) {
          demoteLeader('another tab claimed leadership');
        }
        return;
      }

      if (!valid) {
        tryBecomeLeader('monitor');
      }
    }, 5000);
  }

  // ========= Idle logic =========

  // Track user activity (local) and also broadcast heartbeat.
  var activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];
  function markActivityLocal() {
    sharedState.lastActivityAt = nowMs();
    postMessage({ type: 'heartbeat', lastActivity: sharedState.lastActivityAt, leaderId: (readLease() || {}).leaderId || null });
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

  function shouldWarnByIdle() {
    return (nowMs() - sharedState.lastActivityAt) >= getWarnOffsetMs();
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
    // - If we are leader: do keepalive.
    // - If not leader: forward to leader. If leader is hidden/throttled, request a visible leader.
    stayBtn.addEventListener('click', function () {
      // UX: disable quickly in this tab; we'll re-enable when modal closes or on failure message.
      stayBtn.disabled = true;
      setModalStatus('Keeping you signed in...');

      if (leaderState.isLeader) {
        doKeepAliveLeader().finally(function () {
          // If modal remains open due to failure, re-enable.
          if (modalEl && modalEl.classList.contains('tl-open')) stayBtn.disabled = false;
        });
        return;
      }

      // Ask for visible leadership if current leader is likely throttled.
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

  function ajaxCheckSessionLeader() {
    leaderState.lastAjaxCheckAt = nowMs();

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
      });
  }

  function computeWarnAtFromActivity() {
    return sharedState.lastActivityAt + getWarnOffsetMs();
  }

  function leaderMainTick(forceImmediateAjaxCheck) {
    if (!leaderState.isLeader) return;
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
    // - or on normal cadence
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

    // Perform ajaxcheck (leader only).
    var ajaxPromise = Promise.resolve();
    if (doAjax) {
      ajaxPromise = ajaxCheckSessionLeader().catch(function () {
        // If ajaxcheck fails, rely on idle threshold for warning; do not spam.
        dbg('ajaxcheck failed; relying on local idle');
      });
    }

    // Schedule next tick with planned time & drift correction.
    ajaxPromise.finally(function () {
      // Leadership might have changed during async work.
      if (!leaderState.isLeader) return;

      var interval = leaderCadenceMs();
      scheduleLeaderTick(interval);
    });
  }

  function doKeepAliveLeader() {
    if (!leaderState.isLeader) {
      // Should never happen; non-leaders forward instead.
      return Promise.resolve();
    }
    if (!hasLeadership()) {
      demoteLeader('keepalive but lease lost');
      return Promise.resolve();
    }

    ensureModal();
    setModalStatus('Keeping you signed in...');

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
        return ajaxCheckSessionLeader().catch(function () { /* ignore */ });
      })
      .catch(function () {
        // Keep modal open with failure status in leader; other tabs remain waiting.
        setModalStatus('Unable to refresh session. Please save your work.');
      });
  }

  // ========= Visibility handling =========

  function onVisibilityChange() {
    // Any tab that becomes visible should attempt to claim leadership if lease is expired.
    if (!document.hidden) {
      // Always resync state quickly on visible:
      // - If we are leader: immediate ajaxcheck before deciding modal state.
      // - If not: request leader to do immediate check (and possibly a visible tab will take lead).
      if (leaderState.isLeader) {
        leaderMainTick(true);
      } else {
        postMessage({ type: 'request_lead' });
      }
    }

    // Leader adjusts cadence automatically via leaderCadenceMs() scheduling.
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
      onVisibilityChange();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
