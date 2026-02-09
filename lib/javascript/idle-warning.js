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
 *     keepAliveUrl: TL_BASE_HREF + 'index.php',
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
      keepAliveUrl: baseHref + 'index.php',
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
  var warningDeadlineAt = null; // timestamp when we will consider session expired (client-side)
  var lastServerValidAt = Date.now();
  var lastAjaxCheckAt = 0;

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
    }
  }

  function setModalStatus(msg) {
    if (!modalEl) return;
    var statusEl = modalEl.querySelector('[data-role="status"]');
    if (statusEl) statusEl.textContent = msg || '';
  }

  function openModal(deadlineAt) {
    ensureModal();
    warningShown = true;
    warningDeadlineAt = deadlineAt;

    setModalStatus('');
    modalEl.classList.add('tl-open');
    startCountdown();
  }

  function closeModal() {
    if (!modalEl) return;
    modalEl.classList.remove('tl-open');
    stopCountdown();
    setModalStatus('');
    warningShown = false;
    warningDeadlineAt = null;
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
    // Optional: preserve destination if TL uses it; we keep it minimal and compatible.
    window.location.href = CONFIG.redirectOnExpireUrl;
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

        if (data.validSession) {
          lastServerValidAt = Date.now();
          // If user previously saw warning, and server says session is valid again, close it.
          // (This typically happens after keepalive)
          if (warningShown) {
            closeModal();
          }
        } else {
          redirectToExpired();
        }

        return data;
      });
  }

  function doKeepAlive() {
    ensureModal();
    var stayBtn = modalEl.querySelector('[data-role="stay"]');
    if (stayBtn) stayBtn.disabled = true;

    setModalStatus('Keeping you signed in...');

    fetch(CONFIG.keepAliveUrl, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store'
    })
      .then(function (resp) {
        if (!resp.ok) {
          throw new Error('keepalive http ' + resp.status);
        }
        // Keepalive succeeded; treat this as activity and immediately re-check session.
        markActivity();
        lastServerValidAt = Date.now();
        setModalStatus('');
        closeModal();

        // Trigger a quick ajaxcheck so UI aligns with server state.
        return ajaxCheckSession().catch(function () {
          // Silent; do not re-open modal on transient errors.
        });
      })
      .catch(function () {
        // If keepalive fails, keep modal open and let countdown / ajaxchecks decide.
        setModalStatus('Unable to refresh session. Please save your work.');
      })
      .finally(function () {
        if (stayBtn) stayBtn.disabled = false;
      });
  }

  /**
   * Compute a client-side deadline to show in the countdown.
   *
   * Server does not provide remaining time in current ajaxcheck response, so we:
   * - warn when we *think* we are within warnThreshold of expiry
   * - and set the countdown deadline to warnThreshold minutes from now (acts as a UX countdown).
   *
   * The real authority remains server ajaxcheck; when it returns invalid, we redirect immediately.
   */
  function computeWarningDeadlineAt() {
    return Date.now() + (CONFIG.warnThresholdMinutes * 60 * 1000);
  }

  function maybeWarn() {
    // We warn if either:
    //  1) local idle exceeds threshold (graceful degradation / no network),
    //  2) or server ajaxcheck recently succeeded but user is now idle beyond threshold.
    //
    // Because server does not expose remaining-time fields, we cannot perfectly predict.
    // However, this meets the requirement: warn based on configured threshold and ajaxcheck validity.
    if (warningShown) return;

    // If ajaxcheck is working, prefer idle-based warning as the user nears inactivity timeout.
    if (shouldWarnByLocalIdle()) {
      openModal(computeWarningDeadlineAt());
    }
  }

  function mainLoopTick() {
    // Always try to check session periodically, regardless of user activity.
    ajaxCheckSession()
      .catch(function () {
        // Degrade gracefully: if ajaxcheck fails, don't throw UX errors;
        // show warning only if local idle exceeds threshold.
        maybeWarn();
      })
      .finally(function () {
        // Additionally, if network is fine but user is idle, warn.
        maybeWarn();
      });
  }

  function start() {
    // Do not run on login.php itself (or logout pages) even if accidentally included.
    var path = (window.location.pathname || '').toLowerCase();
    if (path.indexOf('login.php') !== -1) {
      return;
    }

    // Modal is inserted on load.
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
