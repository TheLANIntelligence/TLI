// The marketing tour is entirely local and predetermined. No product APIs,
// model requests, device discovery, tracking, or visitor prompts are involved.
document.documentElement.classList.add('js');
const $ = (id) => document.getElementById(id);
const mobile = matchMedia('(max-width: 620px)');
const stacked = matchMedia('(max-width: 800px)');

const menu = document.querySelector('.menu-toggle');
const navigation = $('site-nav');
function closeMenu(returnFocus = false) {
  if (!menu || !navigation) return;
  navigation.classList.remove('open');
  menu.setAttribute('aria-expanded', 'false');
  menu.setAttribute('aria-label', 'Open navigation');
  if (returnFocus) menu.focus();
}
menu?.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  menu.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  navigation.classList.toggle('open', open);
});
navigation?.addEventListener('click', (event) => {
  if (event.target.closest('a')) closeMenu();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && menu?.getAttribute('aria-expanded') === 'true') closeMenu(true);
});
mobile.addEventListener('change', () => closeMenu());

function tabs(selector, onSelect) {
  const buttons = [...document.querySelectorAll(selector)];
  const select = (button) => {
    buttons.forEach((item) => {
      item.setAttribute('aria-selected', String(item === button));
      item.tabIndex = item === button ? 0 : -1;
      item.classList.toggle('active', item === button);
    });
    onSelect(button);
  };
  buttons.forEach((button, index) => {
    button.addEventListener('click', () => select(button));
    button.addEventListener('keydown', (event) => {
      const vertical = button.closest('[role="tablist"]')?.getAttribute('aria-orientation') === 'vertical';
      const forward = vertical ? 'ArrowDown' : 'ArrowRight';
      const backward = vertical ? 'ArrowUp' : 'ArrowLeft';
      let next;
      if (event.key === forward) next = (index + 1) % buttons.length;
      if (event.key === backward) next = (index - 1 + buttons.length) % buttons.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = buttons.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      select(buttons[next]);
      buttons[next].focus();
    });
  });
}

function productImage(image, name, alt, sizes = '(max-width: 800px) 94vw, 80vw') {
  image.src = `/assets/product/${name}.webp`;
  image.srcset = `/assets/product/${name}-960.webp 960w, /assets/product/${name}.webp 1440w`;
  image.sizes = sizes;
  image.alt = alt;
}

tabs('[data-chapter]', (button) => {
  const chapter = button.dataset.chapter;
  document.querySelectorAll('.tour-panel').forEach((panel) => { panel.hidden = panel.id !== `tour-${chapter}`; });
  $('tour-title').textContent = { think: 'Ask TLI', create: 'Create with TLI', connect: 'Your connected home' }[chapter];
});
const chapterList = document.querySelector('.tour-chapters');
function chapterOrientation() { chapterList?.setAttribute('aria-orientation', stacked.matches ? 'horizontal' : 'vertical'); }
chapterOrientation();
stacked.addEventListener('change', chapterOrientation);

const thinkExamples = {
  write: {
    prompt: 'Help me write a warm invitation for a relaxed dinner with friends this Saturday.',
    reply: "Hey everyone! Come over for dinner this Saturday around 7. Nothing fancy—just good food, a few familiar faces, and time to catch up. Let me know if you can make it, and if there’s anything you don’t eat. Can’t wait to see you!",
  },
  plan: {
    prompt: 'Help me plan a calm Sunday: a little time outside, a good lunch, and space to recharge.',
    steps: ['Morning: take an unhurried walk somewhere green. Leave room to stop for a coffee.', 'Midday: make a simple lunch you enjoy. Put on an album and take your time.', 'Afternoon: choose one thing just for you—a book, a project, or absolutely nothing.'],
  },
};
let selectedThought = 'write';
document.querySelectorAll('[data-think]').forEach((button) => {
  button.addEventListener('click', () => {
    selectedThought = button.dataset.think;
    document.querySelectorAll('[data-think]').forEach((item) => {
      item.classList.toggle('selected', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    $('think-prompt').textContent = thinkExamples[selectedThought].prompt;
    $('think-response').hidden = true;
    $('think-next').innerHTML = 'See an example reply <span aria-hidden="true">↗</span>';
  });
});
$('think-next')?.addEventListener('click', () => {
  const response = $('think-response');
  if (!response.hidden) {
    response.hidden = true;
    $('think-next').innerHTML = 'See an example reply <span aria-hidden="true">↗</span>';
    return;
  }
  const example = thinkExamples[selectedThought];
  const content = document.createElement(example.steps ? 'ol' : 'p');
  if (example.steps) {
    example.steps.forEach((step) => {
      const item = document.createElement('li');
      item.textContent = step;
      content.append(item);
    });
  } else content.textContent = example.reply;
  $('think-response-text').replaceChildren(content);
  response.hidden = false;
  $('think-next').textContent = 'Start this example again ↻';
});

let revision = 1;
function calculate() {
  const bill = $('bill');
  const party = $('people');
  const total = $('calculator-total');
  if (!bill || !party || !total) return;
  const billValue = bill.valueAsNumber;
  const partyValue = revision === 2 ? party.valueAsNumber : 1;
  const validBill = Number.isFinite(billValue) && billValue >= 0 && billValue <= 99999;
  const validParty = Number.isInteger(partyValue) && partyValue >= 1 && partyValue <= 20;
  bill.setAttribute('aria-invalid', String(!validBill));
  party.setAttribute('aria-invalid', String(!validParty));
  total.textContent = validBill && validParty ? ((billValue * (1 + Number($('tip').value) / 100)) / partyValue).toLocaleString('en-US', { style: 'currency', currency: 'USD' }) : '—';
}
$('create-next')?.addEventListener('click', () => {
  const open = $('calculator').hidden;
  $('calculator').hidden = !open;
  $('create-next').textContent = open ? 'Close the sample preview ↗' : 'Open the sample preview ↗';
  calculate();
});
$('improve-app')?.addEventListener('click', () => {
  revision = revision === 1 ? 2 : 1;
  $('people-field').hidden = revision === 1;
  $('revision-label').textContent = `REVISION 0${revision}`;
  $('total-label').textContent = revision === 2 ? 'Per person, with tip' : 'Total, with tip';
  $('improve-app').textContent = revision === 2 ? 'View the earlier revision ↶' : 'Try a revision: split the bill ↗';
  calculate();
});
['bill', 'tip', 'people'].forEach((id) => $(id)?.addEventListener('input', calculate));

let commandStep = 0;
$('connect-next')?.addEventListener('click', () => {
  commandStep = (commandStep + 1) % 3;
  const receipt = $('command-receipt');
  const button = $('connect-next');
  $('lamp-scene').classList.toggle('is-on', commandStep === 2);
  if (commandStep === 1) {
    receipt.textContent = '1 / Acknowledged. The example command was accepted. Its outcome has not been checked yet.';
    $('lamp-status').textContent = 'Example Shelly switch · awaiting check';
    button.textContent = 'Show the example state check ↗';
  } else if (commandStep === 2) {
    receipt.textContent = '2 / State checked. In this example, the device reports that Office Lamp is on.';
    $('lamp-status').textContent = 'Example Shelly switch · reported on';
    button.textContent = 'Start this example again ↻';
  } else {
    receipt.textContent = 'Ready to walk through an example.';
    $('lamp-status').textContent = 'Example Shelly switch · off';
    button.textContent = 'Send the example request ↗';
  }
});

const connections = {
  host: ['THE STARTING POINT', 'Your main computer', 'Your conversations and saved work stay with the TLI host. Run an installed local model here to use general AI without the internet.'],
  model: ['COMPUTE YOU CHOOSE', 'Another trusted computer', 'Review the computer’s identity and inference permission, then explicitly select its model. The host keeps the conversation context. Requests do not silently fall back to another peer.'],
  home: ['CONTROLS WITH CONTEXT', 'Shelly and other supported devices', 'Turn a configured, compatible Shelly switch on or off by name, check its reported state, and see power readings where supported. Other adapters have their own requirements. Saved routines are reviewed and run manually.'],
  phone: ['COMPANION BETA', 'Your home AI, on your phone', 'Get Android Companion from the download page without email verification. Chat, ask about photos and documents, and return to saved conversations on your home Wi-Fi. Choose Connect phone on your computer, then scan its pairing QR code inside the app. Your computer must stay running; AI answers need a configured model. Physical phone and network testing remains in progress.'],
};
document.querySelectorAll('[data-network]').forEach((button) => {
  button.addEventListener('click', () => {
    document.querySelectorAll('[data-network]').forEach((item) => {
      item.classList.toggle('selected', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    const [label, title, description] = connections[button.dataset.network];
    $('network-label').textContent = label;
    $('network-title').textContent = title;
    $('network-description').textContent = description;
  });
});

const workspaces = {
  files: 'Files: browse host folders and review rename or organization plans before applying them. Free Space adds storage maps and reviewed cleanup.',
  vault: 'Vault: protect files, notes, secrets, and saved logins with a separate passphrase, and create portable encrypted Vault backups.',
  computers: 'Computers: review trusted TLI hosts for LAN messages, approved file transfers, supported checks, and explicitly selected text inference. Each connection needs the appropriate permission.',
};
tabs('[data-workspace]', (button) => {
  const name = button.dataset.workspace;
  productImage($('workspace-image'), `now-${name}`, `Current TLI ${name} workspace, with illustrative data.`, '(max-width: 800px) 94vw, 62vw');
  $('workspace-caption').textContent = `${workspaces[name]} 1.4.0-beta · example workspace.`;
  $('workspace-panel').setAttribute('aria-labelledby', button.id);
});

const comparisons = {
  chat: ['ask-emerald-light', 'From the early chat panel to a focused space for questions, writing, planning, ideas, and code.'],
  dashboard: ['now-dashboard', 'From an early console of panels to a cohesive overview, with useful shortcuts, retained activity, and saved places.'],
  vault: ['now-vault', 'The same important purpose, refined: clearer protection states and a more deliberate home for sensitive saved work.'],
  files: ['now-files', 'A clearer place to navigate files, review operations, and keep the work in view.'],
};
tabs('[data-compare]', (button) => {
  const name = button.dataset.compare;
  productImage($('comparison-before'), `early-${name}`, `Early TLI ${name}, reconstructed from retained May 2026 source with example data.`);
  productImage($('comparison-now'), comparisons[name][0], `TLI 1.4.0-beta ${name}, with example data.`);
  $('comparison-description').textContent = comparisons[name][1];
  $('comparison-panel').setAttribute('aria-labelledby', button.id);
});
function comparisonMode(mode) {
  if (!$('comparison-stage')) return;
  $('comparison-stage').dataset.mode = mode;
  const value = mode === 'before' ? 0 : mode === 'now' ? 100 : 50;
  $('comparison-range').value = String(value);
  $('comparison-range').setAttribute('aria-valuetext', `${value} percent current interface`);
  $('comparison-stage').style.setProperty('--reveal', `${value}%`);
  document.querySelectorAll('[data-compare-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.compareMode === mode));
  });
}
document.querySelectorAll('[data-compare-mode]').forEach((button) => button.addEventListener('click', () => comparisonMode(button.dataset.compareMode)));
$('comparison-range')?.addEventListener('input', (event) => {
  const value = Number(event.target.value);
  $('comparison-stage').style.setProperty('--reveal', `${value}%`);
  event.target.setAttribute('aria-valuetext', `${value} percent current interface`);
});
comparisonMode(mobile.matches ? 'now' : 'split');
mobile.addEventListener('change', () => comparisonMode(mobile.matches ? 'now' : 'split'));

const themes = {
  pacific: ['Pacific', 'Layered ocean blue with luminous aqua edges.', 'rgba(85,192,181,.1)'],
  'emerald-light': ['Emerald Light', 'Fresh sage, forest ink, and confident emerald.', 'rgba(141,195,148,.13)'],
  midnight: ['Midnight', 'Quiet charcoal, soft mint, and room to focus.', 'rgba(107,139,125,.09)'],
  oled: ['OLED', 'True-black surfaces with clean emerald highlights.', 'rgba(0,0,0,.1)'],
  copper: ['Copper', 'Warm charcoal, copper accents, and inset detail.', 'rgba(192,126,78,.14)'],
  'rose-quartz': ['Rose Quartz', 'Soft mineral pink, plum ink, and rose details.', 'rgba(197,141,175,.14)'],
};
tabs('[data-theme]', (button) => {
  const key = button.dataset.theme;
  const [label, description, glow] = themes[key];
  productImage($('theme-image'), `ask-${key}`, `Ask TLI 1.4.0-beta in ${label}, with example data.`);
  $('theme-name').textContent = label;
  $('theme-caption').textContent = `${label} — ${description}`;
  $('theme-panel').style.setProperty('--theme-halo', glow);
  $('theme-panel').setAttribute('aria-labelledby', button.id);
});

const motionToggle = document.querySelector('.motion-toggle');
const heroField = document.querySelector('.hero-field');
motionToggle?.addEventListener('click', () => {
  const paused = motionToggle.getAttribute('aria-pressed') !== 'true';
  motionToggle.setAttribute('aria-pressed', String(paused));
  motionToggle.setAttribute('aria-label', paused ? 'Resume background motion' : 'Pause background motion');
  motionToggle.querySelector('.motion-toggle-label').textContent = paused ? 'Resume motion' : 'Pause motion';
  motionToggle.querySelector('.motion-toggle-icon').textContent = paused ? '▷' : 'Ⅱ';
  heroField?.classList.toggle('motion-paused', paused);
});

const animatedRegions = document.querySelectorAll('.network-map, .hero-field');
function refreshMotionVisibility() {
  animatedRegions.forEach((element) => {
    const rect = element.getBoundingClientRect();
    element.classList.toggle('is-in-view', !document.hidden && rect.bottom > 0 && rect.top < innerHeight);
  });
}
refreshMotionVisibility();
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver((entries) => entries.forEach(({ target, isIntersecting }) => {
    target.classList.toggle('is-in-view', isIntersecting && !document.hidden);
  }));
  animatedRegions.forEach((element) => observer.observe(element));
} else {
  window.addEventListener('scroll', refreshMotionVisibility, { passive: true });
  window.addEventListener('resize', refreshMotionVisibility);
}
document.addEventListener('visibilitychange', refreshMotionVisibility);
