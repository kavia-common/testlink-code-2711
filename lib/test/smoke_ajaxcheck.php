<?php
/**
 * Smoke test for login.php?do=ajaxcheck output.
 *
 * This script is intended to be run from CLI in environments where PHP is available:
 *   php lib/test/smoke_ajaxcheck.php
 *
 * It performs a minimal include of login.php in "ajaxcheck" mode and validates:
 *  - response is JSON
 *  - JSON contains boolean key "validSession"
 *
 * NOTE: This is a smoke test, not a full integration test (no real HTTP server, no cookies).
 * It mainly guards against regressions where ajaxcheck emits HTML, warnings, or invalid JSON.
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');

// Simulate minimal web server variables used by common.php / login.php.
$_SERVER['SCRIPT_FILENAME'] = 'login.php';
$_SERVER['SCRIPT_NAME'] = '/login.php';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['REQUEST_URI'] = '/login.php?do=ajaxcheck';

// Route selection in login.php uses R_PARAMS() and expects the action param to map to 'do'.
$_GET = array('do' => 'ajaxcheck');
$_REQUEST = $_GET;

// Capture output.
ob_start();
require_once(dirname(__DIR__, 2) . '/login.php');
$out = ob_get_clean();

// Basic JSON validation.
$data = json_decode($out, true);
if (!is_array($data)) {
  fwrite(STDERR, "FAIL: ajaxcheck did not return JSON.\n");
  fwrite(STDERR, "Output:\n" . $out . "\n");
  exit(1);
}
if (!array_key_exists('validSession', $data) || !is_bool($data['validSession'])) {
  fwrite(STDERR, "FAIL: ajaxcheck JSON missing boolean validSession.\n");
  fwrite(STDERR, "Decoded:\n" . print_r($data, true) . "\n");
  exit(1);
}

fwrite(STDOUT, "OK: ajaxcheck returned valid JSON with validSession=" . ($data['validSession'] ? 'true' : 'false') . "\n");
exit(0);
