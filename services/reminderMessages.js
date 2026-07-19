/**
 * Rotating message pools for daily reminder pushes.
 *
 * Each user gets a different message every day (deterministic: dayOfYear +
 * user hash, so no repeats until a pool cycles and no two ticks disagree).
 * Lunch messages come in two pools — streak holders get "{streak}" substituted
 * with their current count; everyone else gets a "start a streak" flavor.
 */

const LUNCH_STREAK_MESSAGES = [
  { title: 'Lunch o’clock 🥙', body: 'Log your lunch and that {streak}-day streak lives another day 🔥' },
  { title: 'Psst... it’s lunch time 👀', body: 'Your {streak}-day streak called. It wants lunch logged.' },
  { title: 'Midday check-in 🍴', body: 'What are you eating? Log it and keep the {streak}-day flame burning 🔥' },
  { title: 'Streak status: hungry 🔥', body: '{streak} days strong! A quick lunch log keeps it rolling.' },
  { title: 'Lunch break! 🥪', body: 'Take 10 seconds, log your meal, protect the {streak}-day streak. Deal?' },
  { title: 'Don’t ghost your streak 🥲', body: '{streak} days and counting — log lunch so it doesn’t get lonely.' },
  { title: 'Fuel check ⛽', body: 'Whatever’s on your plate, it counts! Log it and day {streak} is safe.' },
  { title: 'It’s lunch, legend 😎', body: 'Champions log their meals. Your {streak}-day streak agrees.' },
  { title: 'Nom nom noted? 📝', body: 'Log today’s lunch and watch that {streak}-day streak grow up so fast 🥹' },
  { title: 'Lunch alert 🚨', body: 'This is not a drill — log your meal and keep {streak} days of momentum!' },
  { title: 'Hey, food person 🍜', body: 'Eating something good? Log it! Streak day {streak} depends on you.' },
  { title: 'Your streak is watching 👁️🔥', body: '{streak} days of greatness. One lunch log keeps the dream alive.' },
  { title: 'Quick! While it’s hot 🍲', body: 'Log lunch before you forget — your {streak}-day streak will thank you.' },
  { title: 'Lunch logged = streak locked 🔒', body: 'Ten seconds now, {streak}+1 days of glory later.' },
  { title: 'Bon appétit! 🇫🇷', body: 'Fancy or leftovers, it all counts. Log it for streak day {streak}!' },
  { title: 'The streak must go on 🎭', body: 'Day {streak} of your food story — don’t leave this page blank!' },
  { title: 'Lunch, then legend status 🏆', body: 'Log today’s meal and your {streak}-day streak keeps climbing.' },
  { title: 'Tiny task, big flex 💪', body: 'Log lunch → keep {streak}-day streak → feel unstoppable. Simple math.' },
  { title: 'What’s on the menu? 🧐', body: 'Inquiring minds (and your {streak}-day streak) want to know. Log it!' },
  { title: 'Midday flame check 🔥', body: 'Your streak’s at {streak} days. Feed it a lunch log and it purrs.' },
  { title: 'Lunch happened. Prove it 😏', body: 'One tap, one log, and streak day {streak} goes in the books.' },
  { title: 'Snack, feast, or vibes? 🍕', body: 'Whatever lunch was, log it — {streak} days of streak on the line!' },
  { title: 'You + lunch = iconic 💫', body: 'Make it official in the app. Day {streak} of the streak awaits.' },
  { title: 'Keep the chain going ⛓️🔥', body: '{streak} days linked so far. Today’s lunch is the next link!' },
  { title: 'Food diary time 📔', body: 'Future you loves this habit. Log lunch, save streak day {streak}.' },
  { title: 'Ding! Lunch reminder 🛎️', body: 'Room service for your {streak}-day streak: one lunch log, please.' },
  { title: 'Streak insurance 🛡️', body: 'Logging lunch now = {streak}-day streak fully protected. Smart move.' },
  { title: 'Real ones log lunch 🤝', body: 'And you’ve been real for {streak} days straight. Keep it up!' },
  { title: 'Your fridge misses you 🥺', body: 'Pop in, log lunch, and keep that beautiful {streak}-day streak alive.' },
  { title: 'Halfway through the day 🌗', body: 'Perfect time to log a meal — streak day {streak} is almost yours.' },
];

const LUNCH_STARTER_MESSAGES = [
  { title: 'Lunch o’clock 🥙', body: 'It’s lunch time! Log your meal and get a streak going 🔥' },
  { title: 'Start something today 🔥', body: 'Log your lunch and day 1 of your streak is in the books!' },
  { title: 'Midday check-in 🍴', body: 'What are you eating? Log it — streaks have to start somewhere 😉' },
  { title: 'Psst... it’s lunch time 👀', body: 'One lunch log today and boom — you’ve got a streak tomorrow.' },
  { title: 'Lunch break! 🥪', body: 'Take 10 seconds, log your meal, and light that first streak flame 🔥' },
  { title: 'New habit, who dis? 📱', body: 'Log today’s lunch and start a streak you’ll want to protect.' },
  { title: 'Day 1 starts now 💪', body: 'Every legendary streak started with one lunch log. Yours too?' },
  { title: 'Fuel check ⛽', body: 'Whatever’s on your plate, it counts — log it and start your streak!' },
  { title: 'Lunch alert 🚨', body: 'This is not a drill — log your meal and kick off a brand new streak!' },
  { title: 'Hey, food person 🍜', body: 'Eating something good? Log it and watch a streak come to life 🔥' },
  { title: 'The flame awaits 🔥', body: 'Your streak flame is unlit. One lunch log fixes that today.' },
  { title: 'Quick! While it’s hot 🍲', body: 'Log lunch before you forget — future streak-you will be grateful.' },
  { title: 'Bon appétit! 🇫🇷', body: 'Fancy or leftovers, it all counts. Log it and start streaking 😄' },
  { title: 'Food diary time 📔', body: 'Log today’s lunch — it’s the first page of a great streak story.' },
  { title: 'Ding! Lunch reminder 🛎️', body: 'One quick lunch log and your streak journey officially begins 🚀' },
];

const DINNER_MESSAGES = [
  { title: 'What’s for dinner? 🍳', body: 'Peek at your recipes and see what you can whip up tonight!' },
  { title: 'Fridge roulette 🎰', body: 'Spin through your recipes — dinner might already be in your fridge.' },
  { title: 'Chef mode: ON 👨‍🍳', body: 'Tonight’s special is... whatever you’ve got! Check your recipes.' },
  { title: 'Dinner ideas incoming 💡', body: 'Don’t stare into the fridge — your saved recipes have answers.' },
  { title: 'The 5 PM question 🤔', body: '"What’s for dinner?" Your recipe collection has thoughts.' },
  { title: 'Skip the takeout tonight? 🥡', body: 'You’ve got recipes and ingredients — let’s see what matches!' },
  { title: 'Tonight’s menu awaits 📜', body: 'Browse your recipes and pick a winner before hanger strikes.' },
  { title: 'Cooking o’clock 🕠', body: 'Something in your recipe stash is begging to be made tonight.' },
  { title: 'Fridge vs. dinner: FIGHT 🥊', body: 'Spoiler: you win. Check your recipes and claim your meal.' },
  { title: 'Dinner inspo, served 🍽️', body: 'Your saved recipes miss you. Go see what you can make tonight!' },
  { title: 'Mystery basket time 🧺', body: 'You’ve got the ingredients — your recipes know what to do with them.' },
  { title: 'Hungry yet? 😋', body: 'Beat the dinner scramble — browse your recipes while it’s still chill.' },
  { title: 'Don’t let the veggies win 🥦', body: 'Something in your fridge expires eventually. Cook it tonight!' },
  { title: 'Tonight, we feast 🏰', body: 'Or at least we check the recipes and make something decent 😄' },
  { title: 'Your kitchen called 📞', body: 'It said "let’s make something tonight." Recipes are waiting!' },
  { title: 'Recipe radar activated 📡', body: 'Scanning your collection for tonight’s dinner... go take a look!' },
  { title: 'Dinner: the final boss 🎮', body: 'Your recipes are the cheat code. Open up and pick one!' },
  { title: 'Plot twist: you cook tonight 🎬', body: 'And it’s good. Check your recipes for the script.' },
  { title: 'The pan is judging you 🍳', body: 'Give it something to do — browse your recipes for tonight!' },
  { title: 'Golden hour = dinner hour 🌇', body: 'See what you can make with what you’ve got. It’s probably tasty.' },
  { title: 'Ding ding! Dinner round 🥊', body: 'Your recipes vs. your hunger. Everyone wins. Check them out!' },
  { title: 'Home cooking hits different 🏡', body: 'Your saved recipes agree. Pick one for tonight!' },
  { title: 'One fridge, endless options 🌀', body: 'Okay, several options. Your recipes will narrow it down!' },
  { title: 'Save money, eat great 💸', body: 'Tonight’s dinner is already paid for — it’s in your fridge.' },
  { title: 'Le dîner approche 🇫🇷', body: 'Sounds fancier in French. Check your recipes and cook something!' },
  { title: 'The great dinner debate 🗣️', body: 'End it in 30 seconds — your recipes have the answer.' },
  { title: 'Prep now, thank yourself later ⏰', body: 'A quick recipe browse now beats a hangry scramble at 7.' },
  { title: 'Your ingredients have dreams 💭', body: 'They dream of becoming dinner. Make it happen tonight!' },
  { title: 'Weeknight hero moment 🦸', body: 'Cape optional. Check your recipes and cook something great.' },
  { title: 'Dinner’s not gonna plan itself 😌', body: 'But it’s close — your recipes are one tap away.' },
];

/**
 * Small stable hash so each user rotates through the pool on their own offset.
 */
function hashUserId(userId) {
  let hash = 0;
  const str = String(userId || '');
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/**
 * Deterministically pick today's message for a user: same result for every
 * cron tick that day, next entry tomorrow, no repeats until the pool cycles.
 * @param {Array} pool - message pool
 * @param {string} userId
 * @param {string} localDate - user's local date as 'YYYY-MM-DD'
 */
function pickDailyMessage(pool, userId, localDate) {
  const dayNumber = Math.floor(Date.parse(`${localDate}T00:00:00Z`) / 86400000);
  const index = (dayNumber + hashUserId(userId)) % pool.length;
  return pool[index];
}

/**
 * Today's lunch message: streak holders get their count woven in,
 * everyone else gets a "start a streak" flavor.
 */
function getLunchMessage(userId, localDate, currentStreak) {
  if (currentStreak > 0) {
    const entry = pickDailyMessage(LUNCH_STREAK_MESSAGES, userId, localDate);
    return {
      title: entry.title,
      body: entry.body.replace(/\{streak\}/g, String(currentStreak)),
    };
  }
  return pickDailyMessage(LUNCH_STARTER_MESSAGES, userId, localDate);
}

function getDinnerMessage(userId, localDate) {
  return pickDailyMessage(DINNER_MESSAGES, userId, localDate);
}

module.exports = {
  LUNCH_STREAK_MESSAGES,
  LUNCH_STARTER_MESSAGES,
  DINNER_MESSAGES,
  pickDailyMessage,
  getLunchMessage,
  getDinnerMessage,
};
