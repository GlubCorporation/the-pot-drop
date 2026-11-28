// Installing the site as an app: registers the service worker (sw.js) and
// shows the header's Install button when the browser can install the site.
// iPhones and iPads can't be asked from a page, so there the button explains
// how (Share, then Add to Home Screen). Loaded on every page.
(() => {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  const button = document.getElementById('install-app');
  if (!button) return;
  const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPads report as Macs
  let prompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // our button instead of the browser's own banner
    prompt = e;
    button.hidden = installed();
  });
  window.addEventListener('appinstalled', () => { button.hidden = true; });
  if (ios && !installed()) button.hidden = false;

  button.addEventListener('click', async () => {
    if (prompt) {
      prompt.prompt();
      const { outcome } = await prompt.userChoice;
      prompt = null;
      if (outcome === 'accepted') button.hidden = true;
      return;
    }
    if (!ios) return;
    let tip = document.getElementById('install-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'install-tip';
      tip.className = 'install-tip';
      tip.setAttribute('role', 'status');
      tip.innerHTML = 'To install: tap <strong>Share</strong> <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12"/><path d="m8 7 4-4 4 4"/><path d="M6 11v9h12v-9"/></svg> in Safari, then <strong>Add to Home Screen</strong>.';
      document.body.append(tip);
    }
    tip.hidden = false;
    clearTimeout(tip.timer);
    tip.timer = setTimeout(() => { tip.hidden = true; }, 8000);
  });
})();
