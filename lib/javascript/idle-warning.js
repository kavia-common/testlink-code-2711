/**
 * TestLink idle warning modal (vanilla JS).
 *
 * Periodically checks session validity via login.php ajaxcheck and warns the user
 * 2 minutes before the session is expected to expire (based on server-side
 * sessionInactivityTimeout, when available).
 *
 * Configuration:
 *   window.TL_IDLE_CONFIG = {
 *     checkIntervalMs: 60000,
 *     // Optional: server-side configured inactivity timeout in seconds.
 *     // Used as a fallback when ajaxcheck does not provide a usable value.
 *     sessionInactivityTimeoutSec: 1800,
 *     ajaxCheckUrl: TL_BASE_HREF + 'login.php?do=ajaxcheck',
 *     keepAliveUrl: TL_BASE_HREF + 'lib/ajax/session_keepalive.php',
 *     redirectOnExpireUrl: TL_BASE_HREF + 'login.php?note=expired'
 *   };
 */
(function () {
  'use strict';

  // Avoid double-init (e.g., if included twice by accident).
  if (window.__TL_IDLE_WARNING_INITIALIZED__) {
    return;
  }
  window.__TL_IDLE_WARNING_INITIALIZED__ = true;

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
      checkIntervalMs: 60000, // 60s
      // Safe default fallback if server doesn't tell us the timeout (30 minutes).
      sessionInactivityTimeoutSec: 30 * 60,
      ajaxCheckUrl: baseHref + 'login.php?do=ajaxcheck',
      keepAliveUrl: baseHref + 'lib/ajax/session_keepalive.php',
      redirectOnExpireUrl: baseHref + 'login.php?note=expired'
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
        : defaults.redirectOnExpireUrl
    };
  }

  var CONFIG = getIdleConfig();

  // Track user activity (idle).
  var lastActivityAt = Date.now();
  var activityEvents = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'];

  function markActivity() {
    lastActivityAt = Date.now();
  }

  activityEvents.forEach(function (evt) {
    window.addEventListener(evt, markActivity, { passive: true });
  });

  // Modal state
  var modalEl = null;
  var countdownIntervalId = null;
  var warningShown = false;
  var warningDeadlineAt = null; // timestamp when we will consider session expired (client-side UX countdown)
  var lastAjaxCheckAt = 0;

  // Effective server timeout tracking (seconds)
  // - Updated from ajaxcheck when possible
  // - Fallback to window.TL_IDLE_CONFIG.sessionInactivityTimeoutSec
  var effectiveSessionTimeoutSec = CONFIG.sessionInactivityTimeoutSec;

  // Focus management
  var previouslyFocusedEl = null;

  // Constants
  var WARNING_BEFORE_TIMEOUT_SEC = 120; // 2 minutes

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
   * Supported formats (best effort, to tolerate multiple server implementations):
   * - data.sessionInactivityTimeoutSec (number)
   * - data.sessionInactivityTimeout (number, assumed seconds)
   * - data.timeoutSec (number)
   * - data.timeout (number, assumed seconds)
   *
   * Note: data.timeout_info is a localized string and is not parsed for numeric value here.
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
      // Sometimes numeric values arrive as strings.
      if (typeof data[key] === 'string' && data[key].trim() !== '') {
        var parsed = Number(data[key]);
        if (isFinite(parsed) && parsed > 0) {
          return Math.floor(parsed);
        }
      }
    }
    return null;
  }

  /**
   * Calculate when to show the warning based on the effective session timeout.
   * If timeout is <= 2 minutes, warn almost immediately (1 second) rather than never warning.
   */
  function getWarnOffsetMs() {
    var timeoutMs = effectiveSessionTimeoutSec * 1000;
    var warnOffset = timeoutMs - (WARNING_BEFORE_TIMEOUT_SEC * 1000);
    // Never allow <=0 because it would cause immediate/negative thresholds and bad UX loops.
    return Math.max(1000, warnOffset);
  }

  function shouldWarnByLocalIdle() {
    return (Date.now() - lastActivityAt) >= getWarnOffsetMs();
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
    if (!modalEl) {
      modalEl = buildModal();

      var stayBtn = modalEl.querySelector('[data-role="stay"]');
      stayBtn.addEventListener('click', function () {
        doKeepAlive();
      });

      // Basic focus trap
      modalEl.addEventListener('focusin', function (e) {
        if (!warningShown) return;
        var dialog = modalEl.querySelector('.tl-idle-dialog');
        if (dialog && !dialog.contains(e.target)) {
          stayBtn.focus();
        }
      });
    }
  }

  function setModalStatus(msg) {
    if (!modalEl) return;
    var statusEl = modalEl.querySelector('[data-role="status"]');
    if (statusEl) statusEl.textContent = msg || '';
  }

  /**
   * UX countdown deadline: now + 2 minutes.
   * Server remains authoritative; ajaxcheck redirects immediately on invalid.
   */
  function computeWarningDeadlineAt() {
    return Date.now() + (WARNING_BEFORE_TIMEOUT_SEC * 1000);
  }

  function startCountdown() {
    stopCountdown();
    updateCountdown();
    countdownIntervalId = window.setInterval(updateCountdown, 1000);
  }

  function stopCountdown() {
    if (countdownIntervalId) {
      window.clearInterval(countdownIntervalId);
      countdownIntervalId = null;
    }
  }

  function updateCountdown() {
    if (!modalEl || !warningDeadlineAt) return;

    var now = Date.now();
    var msLeft = warningDeadlineAt - now;

    var timeEl = modalEl.querySelector('[data-role="time"]');
    if (timeEl) timeEl.textContent = formatTimeLeft(msLeft);

    if (msLeft <= 0) {
      redirectToExpired();
    }
  }

  function redirectToExpired() {
    window.location.href = CONFIG.redirectOnExpireUrl;
  }

  function openModal(deadlineAt) {
    ensureModal();

    try {
      previouslyFocusedEl = document.activeElement;
    } catch (e) {
      previouslyFocusedEl = null;
    }

    warningShown = true;
    warningDeadlineAt = deadlineAt;

    setModalStatus('');
    modalEl.classList.add('tl-open');
    startCountdown();

    var stayBtn = modalEl.querySelector('[data-role="stay"]');
    if (stayBtn) {
      window.setTimeout(function () {
        try { stayBtn.focus(); } catch (e) { /* ignore */ }
      }, 0);
    }
  }

  function restoreFocus() {
    if (!previouslyFocusedEl) return;
    if (!document.contains(previouslyFocusedEl)) return;
    try {
      previouslyFocusedEl.focus();
    } catch (e) {
      // ignore
    }
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.classList.remove('tl-open');
    stopCountdown();
    setModalStatus('');
    warningShown = false;
    warningDeadlineAt = null;

    restoreFocus();
    previouslyFocusedEl = null;
  }

  function parseAjaxCheckResponse(text) {
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function ajaxCheckSession() {
    lastAjaxCheckAt = Date.now();

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
        var data = parseAjaxCheckResponse(body);
        if (!data || typeof data.validSession !== 'boolean') {
          throw new Error('ajaxcheck invalid json');
        }

        if (!data.validSession) {
          redirectToExpired();
        }

        // Update effective timeout if server provides it (to track config changes without redeploy).
        var derived = extractTimeoutSecondsFromAjaxCheck(data);
        if (typeof derived === 'number' && derived > 0) {
          effectiveSessionTimeoutSec = derived;
        } else {
          effectiveSessionTimeoutSec = CONFIG.sessionInactivityTimeoutSec;
        }

        return data;
      });
  }

  function resetTimersAfterSuccessfulKeepAlive() {
    // Treat keepalive as user activity and reset the local baseline.
    // This ensures that if config changes (timeout differs), our warn offset stays correct.
    markActivity();
    // Re-read config in case server-injected values changed via page refresh or dynamic override.
    CONFIG = getIdleConfig();
    effectiveSessionTimeoutSec = CONFIG.sessionInactivityTimeoutSec;
    warningDeadlineAt = computeWarningDeadlineAt();
  }

  function doKeepAlive() {
    ensureModal();
    var stayBtn = modalEl.querySelector('[data-role="stay"]');
    if (stayBtn) stayBtn.disabled = true;

    setModalStatus('Keeping you signed in...');

    fetch(CONFIG.keepAliveUrl, {
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
          redirectToExpired();
          return null;
        }

        resetTimersAfterSuccessfulKeepAlive();
        closeModal();

        // Align with server and pick up timeout info if ajaxcheck provides it.
        return ajaxCheckSession().catch(function () { /* ignore */ });
      })
      .catch(function () {
        setModalStatus('Unable to refresh session. Please save your work.');
      })
      .finally(function () {
        if (stayBtn) stayBtn.disabled = false;
      });
  }

  function maybeWarn() {
    if (warningShown) return;

    if (shouldWarnByLocalIdle()) {
      openModal(computeWarningDeadlineAt());
    }
  }

  function mainLoopTick() {
    ajaxCheckSession()
      .catch(function () {
        // Degrade gracefully: if ajaxcheck fails, warn only if local idle exceeds threshold.
        maybeWarn();
      })
      .finally(function () {
        maybeWarn();
      });
  }

  function start() {
    // Do not run on login.php itself even if accidentally included.
    var path = (window.location.pathname || '').toLowerCase();
    if (path.indexOf('login.php') !== -1) {
      return;
    }

    ensureModal();

    window.setTimeout(mainLoopTick, 5000);
    window.setInterval(mainLoopTick, CONFIG.checkIntervalMs);

    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        if (Date.now() - lastAjaxCheckAt > 3000) {
          mainLoopTick();
        }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
