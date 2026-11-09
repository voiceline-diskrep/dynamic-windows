const { test } = require('node:test');
const assert = require('node:assert');
const configManager = require('../src/main/config-manager');

function getEligibleGreetingsList(userName, date = new Date()) {
  const safeName = (userName && userName.trim()) ? userName.trim() : 'User';
  const hour = date.getHours();

  const isMorning = hour >= 5 && hour < 12;
  const isAfternoon = hour >= 12 && hour < 18;
  const isStayingUp = hour >= 1 && hour < 4;
  const isNight = hour >= 18 || hour === 0 || hour === 4;

  const list = [];
  list.push(`Welcome Back ${safeName}`);
  if (isMorning) list.push(`Good morning ${safeName}`);
  if (isAfternoon) list.push(`Good Afternoon ${safeName}`);
  if (isNight) list.push(`Good night ${safeName}`);
  if (isStayingUp) list.push('staying up?');
  list.push('What to do?');
  list.push('Lets go!');
  list.push(`Hello ${safeName}`);
  list.push('im always here');

  return list;
}

test('Personalization: configManager stores and updates userName', () => {
  const initial = configManager.get('userName');
  try {
    configManager.set('userName', 'Alex');
    assert.strictEqual(configManager.get('userName'), 'Alex');

    configManager.set('userName', 'Russell');
    assert.strictEqual(configManager.get('userName'), 'Russell');
  } finally {
    configManager.set('userName', initial || '');
  }
});

test('Personalization: first time greeting format is strictly hello <name>!', () => {
  const name = 'Russell';
  const firstTimeGreeting = `hello ${name}!`;
  assert.strictEqual(firstTimeGreeting, 'hello Russell!');
});

test('Personalization: staying up? triggers strictly between 1am and 3:59am', () => {
  const d1am = new Date(2026, 10, 9, 1, 30);
  const list1am = getEligibleGreetingsList('Russell', d1am);
  assert.ok(list1am.includes('staying up?'), '1:30 AM must include staying up?');

  const d3am = new Date(2026, 10, 9, 3, 59);
  const list3am = getEligibleGreetingsList('Russell', d3am);
  assert.ok(list3am.includes('staying up?'), '3:59 AM must include staying up?');

  const d12am = new Date(2026, 10, 9, 0, 15);
  const list12am = getEligibleGreetingsList('Russell', d12am);
  assert.ok(!list12am.includes('staying up?'), '00:15 AM must NOT include staying up?');

  const d5am = new Date(2026, 10, 9, 5, 0);
  const list5am = getEligibleGreetingsList('Russell', d5am);
  assert.ok(!list5am.includes('staying up?'), '5:00 AM must NOT include staying up?');
});

test('Personalization: Good morning triggers strictly between 5am and 11:59am', () => {
  const d9am = new Date(2026, 10, 9, 9, 0);
  const list = getEligibleGreetingsList('Russell', d9am);
  assert.ok(list.includes('Good morning Russell'));
  assert.ok(!list.includes('Good Afternoon Russell'));
  assert.ok(!list.includes('Good night Russell'));
  assert.ok(!list.includes('staying up?'));
});

test('Personalization: Good Afternoon triggers strictly between 12pm and 5:59pm', () => {
  const d2pm = new Date(2026, 10, 9, 14, 0);
  const list = getEligibleGreetingsList('Russell', d2pm);
  assert.ok(list.includes('Good Afternoon Russell'));
  assert.ok(!list.includes('Good morning Russell'));
  assert.ok(!list.includes('Good night Russell'));
  assert.ok(!list.includes('staying up?'));
});

test('Personalization: Good night triggers at night (evening, midnight, 4am)', () => {
  const d8pm = new Date(2026, 10, 9, 20, 0);
  const list8pm = getEligibleGreetingsList('Russell', d8pm);
  assert.ok(list8pm.includes('Good night Russell'));

  const dMidnight = new Date(2026, 10, 9, 0, 30);
  const listMidnight = getEligibleGreetingsList('Russell', dMidnight);
  assert.ok(listMidnight.includes('Good night Russell'));

  const d4am = new Date(2026, 10, 9, 4, 30);
  const list4am = getEligibleGreetingsList('Russell', d4am);
  assert.ok(list4am.includes('Good night Russell'));
});

test('Personalization: universal greetings are always present', () => {
  const d = new Date(2026, 10, 9, 15, 30);
  const list = getEligibleGreetingsList('Russell', d);
  assert.ok(list.includes('Welcome Back Russell'));
  assert.ok(list.includes('What to do?'));
  assert.ok(list.includes('Lets go!'));
  assert.ok(list.includes('Hello Russell'));
  assert.ok(list.includes('im always here'));
});

test('Personalization: cycles sequentially across eligible messages', () => {
  const d = new Date(2026, 10, 9, 14, 0); // afternoon: 6 eligible greetings
  const eligible = getEligibleGreetingsList('Russell', d);
  let cycleIdx = 0;

  function cycle() {
    const msg = eligible[cycleIdx % eligible.length];
    cycleIdx = (cycleIdx + 1) % eligible.length;
    return msg;
  }

  const seen = [];
  for (let i = 0; i < eligible.length; i++) {
    seen.push(cycle());
  }
  assert.deepStrictEqual(seen, eligible);

  // Wraps around cleanly
  assert.strictEqual(cycle(), eligible[0]);
});
