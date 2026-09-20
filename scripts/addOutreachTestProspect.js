/**
 * Create (or remove) a test prospect in the influencer outreach pipeline.
 *
 * Rehearse the real thing against your own inbox before a creator ever sees it:
 * the row goes through the same drafting path as discovery, lands in "Emails to
 * send" on /admin/influencers, and can be edited and sent from there.
 *
 *   node scripts/addOutreachTestProspect.js --email you@example.com
 *   node scripts/addOutreachTestProspect.js --cleanup
 *
 * The handle is always `test_prospect`, so it is obvious in the dashboard and in
 * the sheet archive, and --cleanup can always find it. Nothing here touches a
 * real creator.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getServiceClient } = require('../config/supabase');
const { prepareEmailTouch } = require('../services/influencerOutreach/sendTouch');

const HANDLE = 'test_prospect';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true);
};

const NAME = 'Test';
const PERSONAL_LINE = 'I love how your weeknight dinners always look doable on a Tuesday, especially the sheet-pan ones.';

// Mirrors trackabite-outreach/templates/email.txt — keep the two in step.
const EMAIL_SUBJECT = 'Paid collab with Trackabite?';
const EMAIL_BODY = `Hey ${NAME}!

I'm Jessie -- a foodie.

I just found your A Busy Kitchen and went down a bit of a rabbit hole 😅 I love how you make weeknight cooking feel doable for people with packed schedules. You have clearly earned your audience's trust, and it shows in the comments.

I'm building a small app called Trackabite.

It's a food inventory app that helps busy cooks track what they have, figure out what to cook, stop wasting groceries, and cook better. (The exact problem your followers and I deal with every week.)

I think your audience would genuinely get value from this app. And if it clicks, it could be a really easy way for you to also earn from something that would actually help them.

Would you be open to a small paid collab? I'm thinking just one short video on your IG + a mention in your community. But I'm open to any ideas.

If you're interested, I'd love to share more details of what I'm thinking.

Either way, keep doing what you're doing. You're rocking it. ♥️

Looking forward to hearing from you.

Best,
Jessie`;

const DM_BODY = `Paid collab?

Hi ${NAME}, ${PERSONAL_LINE}

Quick one: I'm building a small app called Trackabite (helps busy folks keep track of what food they have + figure out what to cook), and I think it could fit really naturally into your content.

Collab-wise, it's super chill. Just your normal video with a natural mention of the app. There's a flat fee per video + bonuses for installs and paid users.

If that sounds interesting to you, I can send over a brief with the details. ❤️

Have a great day!`;

async function cleanup(sb) {
  const { data, error } = await sb.from('influencers').delete().eq('handle', HANDLE).select('id, email');
  if (error) throw error;
  if (!data.length) {
    console.log('Nothing to clean up — no test prospect in the pipeline.');
    return;
  }
  // influencer_touches and influencer_posts cascade on delete.
  console.log(`Removed the test prospect (was pointed at ${data[0].email}).`);
}

async function create(sb, email) {
  const { data: existing } = await sb.from('influencers').select('id').eq('handle', HANDLE).maybeSingle();
  if (existing) {
    console.log('A test prospect already exists. Run with --cleanup first if you want a fresh one.');
    return;
  }

  const { data: inf, error } = await sb.from('influencers').insert({
    platform: 'instagram',
    handle: HANDLE,
    profile_url: 'https://www.instagram.com/instagram/',
    display_name: 'Test Prospect',
    followers: 5000,
    engagement_rate: 4.2,
    bio: 'TEST ROW — not a real creator. Weeknight dinners, meal prep, feeding a family of four.',
    email,
    category: 'busy_home_cook',
    score: 9,
    why: 'Test prospect created by scripts/addOutreachTestProspect.js to rehearse the send flow.',
    evidence_caption: 'sheet-pan dinner that saved my Tuesday',
    draft_dm: DM_BODY,
    agent_draft_dm: DM_BODY,
    draft_email_subject: EMAIL_SUBJECT,
    draft_email: EMAIL_BODY,
    recommended_fee: 65,
    fee_breakdown: { base: 40, engagement_multiplier: 1.0, platform_multiplier: 1.0, note: 'test row' },
    campaign_slug: 'ig_test_prospect',
    tracking_link: 'https://apps.apple.com/app/id6759185932?ct=ig_test_prospect',
    // 'contacted' keeps it out of the DM queue: this rehearsal is about the email.
    status: 'contacted',
  }).select('*').single();
  if (error) throw error;

  const touch = await prepareEmailTouch(inf, 1);
  if (!touch || touch.error) {
    throw new Error(`Drafting the email failed: ${touch ? touch.error : 'no touch created'}`);
  }

  console.log('Test prospect created.');
  console.log(`  to      : ${email}`);
  console.log(`  subject : ${touch.subject}`);
  console.log(`  status  : contacted (shows under "Emails to send")`);
  console.log('\nOpen /admin/influencers, edit the draft, then press Send email.');
  console.log('When you are done: node scripts/addOutreachTestProspect.js --cleanup');
}

(async () => {
  const sb = getServiceClient();
  try {
    if (flag('cleanup')) {
      await cleanup(sb);
      return;
    }
    const email = flag('email');
    if (!email || email === true) {
      console.error('Usage: node scripts/addOutreachTestProspect.js --email you@example.com [| --cleanup]');
      process.exit(1);
    }
    await create(sb, String(email));
  } catch (e) {
    console.error('Failed:', e.message);
    process.exit(1);
  }
})();
