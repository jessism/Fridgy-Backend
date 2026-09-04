/**
 * Who is NOT a real user.
 *
 * One definition, shared by everything that reports numbers: the admin console
 * (services/adminAnalyticsService.js), the PostHog feature tracker
 * (middleware/featureTracking.js) and the admin feedback/promo routes.
 * It used to live inside the analytics service only, which is why PostHog
 * happily recorded every admin, test and system-user action for months.
 *
 * The database is the real source of truth: users.is_test (migration 080) is
 * set automatically by a trigger (migration 081) whenever an address looks
 * internal. Everything below is the backstop that keeps working if the trigger
 * is ever dropped, or the column is not yet applied.
 *
 * Accepts both row shapes: Supabase rows (is_admin / is_test) and req.user
 * (isAdmin / isTest), so callers never have to normalise.
 */

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001'; // migrations/063

/**
 * Internal addresses that contain no obvious marker. Each was confirmed from
 * the data — owner's first_name, zero activity, or sandbox-only IAP events —
 * not guessed from the address.
 */
const DEFAULT_INTERNAL_EMAILS = [
  'hello@trackabite.app',
  'jessie@trackabite.app',
  'trangmh.sac.ftu@gmail.com',      // admin; listed so it holds if that flag is ever revoked
  'system@trackabite.app',          // the system user that owns community recipes
  'adityabiswas1999@hotmail.com',
  'adityabiswas1999@hotmail.coma',  // typo variant; first_name "Aditya", no activity
  'abiswas@sfu.ca',                 // owner's personal address
  'hello@trackabte.app',            // typo of the trackabite.app domain
  'jessietrackie@gmail.com',        // first_name "Trackie"
  'tann.kh0ngtuoc@gmail.com',       // first_name "Jessie"
  'nathannorth2005@gmail.com',      // six daily SANDBOX App Store renewals
  'vancitypcrepairs@gmail.com',     // first_name "Trackabite Meta App Tester"; comped premium for Meta's app review
];

/** ADMIN_ANALYTICS_EXCLUDED_EMAILS adds to the defaults; it never replaces them. */
const INTERNAL_EMAILS = new Set(
  [...DEFAULT_INTERNAL_EMAILS, ...(process.env.ADMIN_ANALYTICS_EXCLUDED_EMAILS || '').split(',')]
    .map((e) => e.trim().toLowerCase()).filter(Boolean)
);

/** example.* and .test are reserved by RFC 2606; trackabte.app is our own typo. */
const INTERNAL_DOMAINS = new Set(['example.com', 'example.org', 'example.net', 'test.com', 'trackabte.app']);

const flag = (u, snake, camel) => (u[snake] !== undefined ? u[snake] : u[camel]);

/**
 * Why this account is not a real user, or null if it is one.
 * Order matters only for which reason is reported, not for the outcome.
 */
function exclusionReason(user) {
  if (!user) return 'no user';
  const email = (user.email || '').toLowerCase();
  const domain = email.slice(email.lastIndexOf('@') + 1);

  if (!email) return 'no email';
  if (user.id === SYSTEM_USER_ID) return 'system user';
  if (flag(user, 'is_test', 'isTest') === true) return 'users.is_test';
  if (flag(user, 'is_admin', 'isAdmin') === true) return 'admin';
  if (INTERNAL_EMAILS.has(email)) return 'internal account';
  if (INTERNAL_DOMAINS.has(domain)) return `reserved domain (${domain})`;
  // Deliberate substring rule: any address containing "test" is internal.
  // No current account is a false positive (checked all 132). If a real
  // customer ever has "test" in their address, drop this line — by then the
  // is_test column is fully maintained by the migration 081 trigger.
  if (email.includes('test')) return 'email contains "test"';
  return null;
}

const isInternalAccount = (user) => exclusionReason(user) !== null;

module.exports = {
  SYSTEM_USER_ID,
  INTERNAL_EMAILS,
  INTERNAL_DOMAINS,
  exclusionReason,
  isInternalAccount,
};
