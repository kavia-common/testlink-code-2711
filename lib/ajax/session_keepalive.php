<?php
/**
 * TestLink session keepalive endpoint.
 *
 * Lightweight authenticated-only endpoint used by the idle warning modal "Stay signed in" action.
 * It:
 *  - starts session
 *  - validates that session is still valid (without redirect)
 *  - refreshes lastActivity
 *  - returns JSON { ok: true } or { ok: false, reason: 'expired' }
 *
 * This endpoint is safe to call frequently and should not mutate application state besides
 * refreshing session activity.
 *
 * @filesource  session_keepalive.php
 * @package     TestLink
 */

require_once('../../config.inc.php');
require_once('../../lib/functions/common.php');

doSessionStart(true);

// Ensure JSON response and prevent caches/proxies from storing it.
header('Content-Type: application/json; charset=UTF-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
header('Pragma: no-cache');

doDBConnect($db, database::ONERROREXIT);

// Validate session without redirecting (caller will handle redirect).
$valid = checkSessionValid($db, false);
if (!$valid) {
  http_response_code(401);
  echo json_encode(array('ok' => false, 'reason' => 'expired'));
  exit;
}

// checkSessionValid() already refreshes lastActivity when valid,
// but we set it explicitly to match the requirement.
$_SESSION['lastActivity'] = time();

echo json_encode(array('ok' => true));
exit;
?>
