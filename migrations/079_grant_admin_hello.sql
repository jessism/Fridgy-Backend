-- Migration 079: grant admin to hello@trackabite.app
-- Purpose: the admin dashboard at trackabite.app/admin/analytics (and
--   /admin/blog) is gated on users.is_admin via middleware/adminAuth.js.
--   Only trangmh.sac.ftu@gmail.com had the flag, so the operations account
--   could not reach it.
-- Note: hello@trackabite.app is already excluded from analytics by email, so
--   this does not change any reported numbers — is_admin is simply a second
--   exclusion reason (see services/adminAnalyticsService.js).
-- Date: 2026-08-29

UPDATE public.users
SET is_admin = TRUE
WHERE lower(email) = 'hello@trackabite.app';
