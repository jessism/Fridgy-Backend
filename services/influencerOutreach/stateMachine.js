/**
 * Status transitions for influencers and batches. Every route and cron job
 * goes through here so the rules live in one place.
 *
 * pending_approval → warmup_needed → dm_needed → contacted ⇄ followup_needed → no_response
 * replied → signed | declined ; side exits: rejected, hold, opted_out, bounced
 */
const { getServiceClient } = require('../../config/supabase');
const config = require('./config');
const { prepareEmailTouch, createDmTask, advanceSchedule, settleStatus } = require('./sendTouch');

const nowIso = () => new Date().toISOString();
const addDays = (d, days) => new Date(new Date(d).getTime() + days * 86400000).toISOString();

/** Calendar date in the outreach timezone, e.g. '2026-09-16'. */
const sessionDay = (iso = Date.now()) =>
  new Date(iso).toLocaleDateString('en-CA', { timeZone: config.TIMEZONE });

const openedToday = (batch) => Boolean(batch) && sessionDay(batch.opened_at) === sessionDay();

/** Every batch still being reviewed or warmed up, oldest first. */
async function openBatches() {
  const sb = getServiceClient();
  const { data, error } = await sb
    .from('influencer_batches')
    .select('*')
    .in('status', ['reviewing', 'warmup_open'])
    .order('opened_at', { ascending: true });
  if (error) throw error;
  return data;
}

/**
 * The batch taking today's approvals. One batch per session: a batch opened on
 * an earlier day is left alone — it is still mid warm-up and will be closed on
 * its own — and a fresh batch is started for today, so "Done warming up for
 * all" never mixes creators warmed for three days with ones approved minutes ago.
 */
async function currentOpenBatch(create = true) {
  const batches = await openBatches();
  const latest = batches[batches.length - 1] || null;
  if (openedToday(latest)) return latest;
  if (!create) return latest;

  const sb = getServiceClient();
  const { data: created, error } = await sb
    .from('influencer_batches')
    .insert({ status: 'reviewing', target: config.batchSize })
    .select('*')
    .single();
  if (error) throw error;
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

/**
 * Drop a creator out of the pipeline entirely — deleted account, went private,
 * asked to be left alone. Unlike reject this says nothing about fit, so the
 * reason is stored but never fed back into scoring. Anything still queued for
 * them disappears from Today, because those lists only include live statuses.
 */
async function removeFromPipeline(id, reason) {
  const patch = {
    status: 'removed',
    next_touch_at: null,
    batch_id: null,
    outcome: 'removed',
    rejected_at: nowIso(),
  };
  const trimmed = (reason || '').trim();
  if (trimmed) patch.rejection_reason = trimmed.slice(0, 500);
  return update(id, patch);
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
 * Warm-up done for one creator: draft email touch 1 (if they have an address)
 * and queue the DM task, then move to dm_needed. Nothing is sent here — the
 * first email waits for Send on the dashboard.
 */
async function warmupDone(id) {
  const inf = await getInfluencer(id);
  if (!inf) throw Object.assign(new Error('Not found'), { status: 404 });
  if (inf.status !== 'warmup_needed') {
    throw Object.assign(new Error(`Cannot finish warm-up from status ${inf.status}`), { status: 409 });
  }
  const emailTouch = await prepareEmailTouch(inf, 1);
  const dmTouch = config.dmOnTouches.includes(1) ? await createDmTask(inf, 1) : null;
  const updated = await update(id, { status: 'dm_needed', warmup_done_at: nowIso() });
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

  const sentAt = nowIso();
  await sb.from('influencer_touches').update({ sent_at: sentAt, sent_by: 'human' }).eq('id', touch.id);

  return update(id, {
    ...advanceSchedule(inf, touch.step, sentAt),
    ...(await settleStatus(sb, inf)),
  });
}

/**
 * Nightly: creators whose next touch is due. Drafts the follow-up email and
 * queues the DM task; neither is sent here — both wait on the dashboard for a
 * click, so every message is seen and editable first.
 *
 * The clock is driven by sends, not drafts (see advanceSchedule), so a creator
 * who still owes a send is skipped rather than having a second draft stacked
 * behind the first. After the last gap following touch 4 → no_response.
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

  const { data: pendingRows } = await sb.from('influencer_touches').select('influencer_id').is('sent_at', null);
  const awaitingSend = new Set((pendingRows || []).map((r) => r.influencer_id));

  const summary = { drafted: 0, dmTasks: 0, noResponse: 0, skipped: 0, errors: 0 };
  for (const inf of due) {
    try {
      const sent = inf.touches_sent || 0;
      if (sent >= 4) {
        await update(inf.id, { status: 'no_response', next_touch_at: null, outcome: 'no_response' });
        summary.noResponse += 1;
        continue;
      }
      if (awaitingSend.has(inf.id)) {
        summary.skipped += 1;
        continue;
      }

      const step = sent + 1;
      const emailTouch = await prepareEmailTouch(inf, step);
      if (emailTouch?.error) summary.errors += 1;
      else if (emailTouch) summary.drafted += 1;

      let dmTouch = null;
      if (config.dmOnTouches.includes(step)) {
        dmTouch = await createDmTask(inf, step);
        summary.dmTasks += 1;
      }

      // Nothing to send on this step (no email address, DM not configured for it):
      // move the clock on so the creator still reaches no_response.
      if (!emailTouch && !dmTouch) {
        await update(inf.id, advanceSchedule(inf, step, now));
        summary.skipped += 1;
      } else {
        await update(inf.id, { status: 'followup_needed' });
      }
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
  currentOpenBatch, openBatches, openedToday, sessionDay,
  getInfluencer, update, approve, hold, reject, removeFromPipeline,
  warmupDone, batchWarmupDone, dmSent, runFollowups, markReplied, addDays,
};
