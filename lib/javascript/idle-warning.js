/**
 * TestLink idle warning modal (vanilla JS).
 *
 * Periodically checks session validity via login.php ajaxcheck and warns the user shortly
 * before the session is expected to expire. Provides a "Stay signed in" action that pings
 * a lightweight authenticated endpoint to refresh last activity.
 *
 * Configuration:
 *   window.TL_IDLE_CONFIG = {
 *     checkIntervalMs: 60000,
 *     warnThresholdMinutes: 5,
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
      warnThresholdMinutes: 5,
      ajaxCheckUrl: baseHref + 'login.php?do=ajaxcheck',
      keepAliveUrl: baseHref + 'lib/ajax/session_keepalive.php',
      redirectOnExpireUrl: baseHref + 'login.php?note=expired'
    };

    var cfg = window.TL_IDLE_CONFIG || {};
    return {
      checkIntervalMs: (typeof cfg.checkIntervalMs === 'number' && cfg.checkIntervalMs > 0)
        ? cfg.checkIntervalMs
        : defaults.checkIntervalMs,
      warnThresholdMinutes: (typeof cfg.warnThresholdMinutes === 'number' && cfg.warnThresholdMinutes > 0)
        ? cfg.warnThresholdMinutes
        : defaults.warnThresholdMinutes,
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

  // Track user activity (idle) independently of server-side expiry checks.
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

  // Focus management (accessibility + UX reliability)
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

  function shouldWarnByLocalIdle() {
    var warnMs = CONFIG.warnThresholdMinutes * 60 * 1000;
    return (Date.now() - lastActivityAt) >= warnMs;
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

    // Scoped CSS (fits classic TestLink look; does not rely on external libs)
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

      // Basic focus trap: if focus moves outside the dialog while open, bring it back.
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
   * Compute a client-side deadline to show in the countdown.
   *
   * Server does not provide remaining time in current ajaxcheck response, so we:
   * - warn when local idle exceeds warnThresholdMinutes
   * - and set a UX countdown deadline to warnThresholdMinutes from "now"
   *
   * Authority remains server ajaxcheck; when it returns invalid, we redirect immediately.
   */
  function computeWarningDeadlineAt() {
    return Date.now() + (CONFIG.warnThresholdMinutes * 60 * 1000);
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

    // Save focus so we can restore it when user stays signed in.
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

    // Move focus into modal for accessibility and to make the "Stay signed in" action reliable.
    var stayBtn = modalEl.querySelector('[data-role="stay"]');
    if (stayBtn) {
      // Using setTimeout ensures element is focusable after rendering.
      window.setTimeout(function () {
        try { stayBtn.focus(); } catch (e) { /* ignore */ }
      }, 0);
    }
  }

  function restoreFocus() {
    // Restore focus if the element is still in the DOM and focusable; otherwise do nothing.
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

    // Restore focus after the modal is hidden.
    restoreFocus();
    previouslyFocusedEl = null;
  }

  function parseAjaxCheckResponse(text) {
    // login.php ajaxcheck returns JSON with at least validSession boolean.
    try {
      return JSON.parse(text);
    } catch (e) {
      return null;
    }
  }

  function ajaxCheckSession() {
    lastAjaxCheckAt = Date.now();

    // Use credentials (cookies). Avoid caching.
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

        // IMPORTANT:
        // Do NOT auto-close the modal on "validSession" alone.
        // The modal must close reliably on *successful keepalive*.
        // Auto-closing here caused cases where the UI could get out-of-sync.
        return data;
      });
  }

  function resetTimersAfterSuccessfulKeepAlive() {
    // Treat keepalive as user activity and restart the UX countdown baseline.
    // Even though the server expiry is authoritative, this resets local idle tracking
    // and prevents the modal from immediately re-opening.
    markActivity();
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
        // Success path is strictly: HTTP 200 with JSON { ok: true }
        if (resp.status === 401) {
          // Expired session
          return resp.json().catch(function () { return { ok: false }; });
        }
        if (!resp.ok) {
          // Non-200 should be treated as failure; keep modal visible.
          throw new Error('keepalive http ' + resp.status);
        }
        return resp.json().catch(function () {
          throw new Error('keepalive invalid json');
        });
      })
      .then(function (data) {
        if (!data || data.ok !== true) {
          // Per requirement:
          // - { ok:false } => expired => redirect
          // - Unknown structure => treat as failure and keep modal visible (handled below)
          redirectToExpired();
          return null;
        }

        // Keepalive succeeded (HTTP 200 and {ok:true}).
        // Must close modal reliably, restore focus, and reset timers.
        resetTimersAfterSuccessfulKeepAlive();
        closeModal();

        // Optional follow-up to align with server state. If it fails transiently, do nothing.
        return ajaxCheckSession().catch(function () { /* ignore */ });
      })
      .catch(function () {
        // Failure: keep modal visible; do not redirect on transport/server errors.
        // Countdown will continue and ajaxcheck will redirect if server deems it expired.
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
        // Degrade gracefully: if ajaxcheck fails, don't throw UX errors;
        // show warning only if local idle exceeds threshold.
        maybeWarn();
      })
      .finally(function () {
        // Additionally, if user is idle, warn.
        maybeWarn();
      });
  }

  function start() {
    // Do not run on login.php itself (or logout pages) even if accidentally included.
    var path = (window.location.pathname || '').toLowerCase();
    if (path.indexOf('login.php') !== -1) {
      return;
    }

    ensureModal();

    // First tick soon after load, then interval.
    window.setTimeout(mainLoopTick, 5000);
    window.setInterval(mainLoopTick, CONFIG.checkIntervalMs);

    // Also: if the tab becomes visible again, do an immediate check.
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        // Avoid spamming: only if last check is old enough.
        if (Date.now() - lastAjaxCheckAt > 3000) {
          mainLoopTick();
        }
      }
    });
  }

  // Start when DOM is ready.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
