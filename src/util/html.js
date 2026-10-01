// Shared by every module that builds an HTML email/SMS body from
// user-supplied text (signup.js, setupForms.js, reminders.js) — kept in one
// place instead of copy-pasted per file.
export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
