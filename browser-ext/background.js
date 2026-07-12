/**
 * The v0 worker is intentionally thin: the MAIN-world content script posts
 * directly to the loopback Studio endpoint. This is the future relay point for
 * coordinating batches across tabs if the extension grows beyond v0.
 */
chrome.runtime.onInstalled.addListener(() => {
  console.log("Praxis Dev Telemetry installed");
});
