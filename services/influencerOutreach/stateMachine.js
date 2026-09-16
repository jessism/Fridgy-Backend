/**
 * Status transitions for influencers and batches. Every route and cron job
 * goes through here so the rules live in one place.
 *
 * pending_approval → warmup_needed → dm_needed → contacted ⇄ followup_needed → no_response
 * replied → signed | declined ; side exits: rejected, hold, opted_out, bounced
 */
const { getServiceClient } = require('../../config/supabase');
const config = require('./config');
const { sendEmailTouch, createDmTask } = require('./sendTouch');

const nowIso = () => new Date().toISOString();
const addDays = (d, days) => new Date(new Date(d).getTime() + days * 86400000).toISOString();

/** The batch currently taking approvals (or being warmed up). Creates one if none. */
async function currentOpenBatch(create = true) {
  const sb = getServiceClient();
  const { data, error } = await sb
    .from('influencer_batches')
    .select('*')
    .in('status', ['reviewing', 'warmup_open'])
    .order('opened_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  if (data.length) return data[0];
  if (!create) return null;
  const { data: created, error: e2 } = await sb
    .from('influencer_batches')
    .insert({ status: 'reviewing', target: config.batchSize })
    .select('*')
    .single();
  if (e2) throw e2;
  return created;
}

async function getInfluencer(id) {
  const sb = getServiceClient();
  const { data, error } = await sb.from('influencers').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return data;
}

async function update(id, patch) {
  const sb = getServiceClient();
  const { data, error } = await sb.from('influencers').update(patch).eq('id', id).select('*').single();
  if (error) throw error;
  return data;
}

/** Approve: assign to tonight's batch, straight into warm-up. */
async function approve(id) {
  const inf = await getInfluencer(id);
  if (!inf) throw Object.assign(new Error('Not found'), { status: 404 });
  if (!['pending_approval', 'hold'].includes(inf.status)) {
    throw Object.assign(new Error(`Cannot approve from status ${inf.status}`), { status: 409 });
  }
  const batch = await currentOpenBatch(true);
  const sb = getServiceClient();
  if (batch.status === 'reviewing') {
    await sb.from('influencer_batches').update({ status: 'warmup_open' }).eq('id', batch.id);
  }
  return update(id, { status: 'warmup_needed', batch_id: batch.id, approved_at: nowIso(), hold_note: null });
}

async function hold(id, note) {
  return update(id, { status: 'hold', hold_note: note || null });
}

/**
 * Reject, optionally with a reason. The reason is what the discovery pipeline
 * reads back as a learned exclusion, so similar profiles score low next run.
 */
async function reject(id, reason) {
  const patch = { status: 'rejected', batch_id: null, rejected_at: nowIso() };
  const trimmed = (reason || '').trim();
  if (trimmed) patch.rejection_reason = trimmed.slice(0, 500);
  try {
    return await update(id, patch);
  } catch (e) {
    // 42703 = migration 090 not applied yet. Reject anyway rather than block the
    // review; the reason is lost, which is better than a stuck creator.
    if (e.code !== '42703') throw e;
    console.warn('[Outreach] rejection_reason column missing (apply migration 090); rejecting without it');
    return update(id, { status: 'rejected', batch_id: null });
  }
}

/**
 * Warm-up done for one creator: send email touch 1 now (if any), create the
 * DM task, move to dm_needed.
 */
async function warmupDone(id) {
  const inf = await getInfluencer(id);
  if (!inf) throw Object.assign(new Error('Not found'), { status: 404 });
  if (inf.status !== 'warmup_needed') {
    throw Object.assign(new Error(`Cannot finish warm-up from status ${inf.status}`), { status: 409 });
  }
  const emailTouch = await sendEmailTouch(inf, 1);
  const dmTouch = config.dmOnTouches.includes(1) ? await createDmTask(inf, 1) : null;
  const patch = { status: 'dm_needed', warmup_done_at: nowIso() };
  if (emailTouch?.sent_at) {
    patch.contacted_at = emailTouch.sent_at;
    patch.last_touch_at = emailTouch.sent_at;
  }
  const updated = await update(id, patch);
  return { influencer: updated, emailTouch, dmTouch };
}

/** Whole batch: every warmup_needed creator in it. */
async function batchWarmupDone(batchId) {
  const sb = getServiceClient();
  const { data: rows, error } = await sb.from('influencers').select('id').eq('batch_id', batchId).eq('status', 'warmup_needed');
  if (error) throw error;
  const results = [];
  for (const r of rows) {
    try {
      results.push({ id: r.id, ...(await warmupDone(r.id)) });
    } catch (e) {
      results.push({ id: r.id, error: e.message });
    }
  }
  await sb.from('influencer_batches').update({ status: 'contacted', warmup_done_at: nowIso() }).eq('id', batchId);
  return results;
}

/**
 * DM sent by hand for the pending DM touch. Completes the touch: step 1 → contacted
 * with next_touch_at; follow-up → back to contacted.
 */
async function dmSent(id) {
  const inf = await getInfluencer(id);
  if (!inf) throw Object.assign(new Error('Not found'), { status: 404 });
  const sb = getServiceClient();
  const { data: pending, error } = await sb
    .from('influencer_touches')
    .select('*')
    .eq('influencer_id', id)
    .eq('channel', 'dm')
    .is('sent_at', null)
    .order('step', { ascending: true })
    .limit(1);
  if (error) throw error;
  const touch = pending[0];
  if (!touch) throw Object.assign(new Error('No DM waiting to be sent'), { status: 409 });

  await sb.from('influencer_touches').update({ sent_at: nowIso(), sent_by: 'human' }).eq('id', touch.id);

  const patch = { last_touch_at: nowIso() };
  if (touch.step === 1) {
    patch.status = 'contacted';
    patch.touches_sent = Math.max(inf.touches_sent || 0, 1);
    patch.contacted_at = inf.contacted_at || nowIso();
    patch.next_touch_at = addDays(nowIso(), config.followupsDays[0]);
  } else if (inf.status === 'followup_needed') {
    patch.status = 'contacted';
  }
  return update(id, patch);
}

/**
 * Nightly: creators whose next touch is due. Sends the follow-up email,
 * queues the DM task when configured, advances the counters. After the last
 * gap following touch 4 → no_response.
 */
async function runFollowups() {
  const sb = getServiceClient();
  const now = nowIso();
  const { data: due, error } = await sb
    .from('influencers')
    .select('*')
    .in('status', ['contacted', 'followup_needed'])
    .lte('next_touch_at', now);
  if (error) throw error;

  const summary = { sent: 0, dmTasks: 0, noResponse: 0, errors: 0 };
  for (const inf of due) {
    try {
      const sent = inf.touches_sent || 0;
      if (sent >= 4) {
        await update(inf.id, { status: 'no_response', next_touch_at: null, outcome: 'no_response' });
        summary.noResponse += 1;
        continue;
      }
      // A creator still waiting on a human DM for the previous step gets the
      // next email anyway; the DM task simply stays in the queue.
      const step = sent + 1;
      const emailTouch = await sendEmailTouch(inf, step);
      if (emailTouch?.sent_at) summary.sent += 1;
      if (emailTouch && !emailTouch.sent_at) summary.errors += 1;

      const patch = { touches_sent: step, last_touch_at: now };
      if (config.dmOnTouches.includes(step)) {
        await createDmTask(inf, step);
        patch.status = 'followup_needed';
        summary.dmTasks += 1;
      }
      const gap = step < 4 ? config.followupsDays[step - 1] : config.followupsDays[config.followupsDays.length - 1];
      patch.next_touch_at = addDays(now, gap);
      await update(inf.id, patch);
    } catch (e) {
      console.error('[Outreach] follow-up failed for', inf.handle, e.message);
      summary.errors += 1;
    }
  }
  return summary;
}

async function markReplied(id, channel = 'dm') {
  return update(id, { status: 'replied', replied_at: nowIso(), reply_channel: channel, next_touch_at: null });
}

module.exports = {
  currentOpenBatch, getInfluencer, update, approve, hold, reject,
  warmupDone, batchWarmupDone, dmSent, runFollowups, markReplied, addDays,
};
