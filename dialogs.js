// Dialogs behave like an app's screens: the back button (or a phone's back
// gesture) closes an open dialog instead of leaving the page. Opening one adds
// a history entry; closing it any other way (✕, Escape, a click outside) takes
// that entry back off. Loaded before each page's own script.
(() => {
  const showModal = HTMLDialogElement.prototype.showModal;
  let ownBack = false; // the popstate from our own history.back(), to ignore

  HTMLDialogElement.prototype.showModal = function openWithHistory() {
    showModal.call(this);
    if (this.id && history.state?.dialog !== this.id) {
      try { history.pushState({ ...history.state, dialog: this.id }, ''); } catch { /* history unavailable */ }
    }
  };

  // `close` doesn't bubble, so listen while it's on its way down.
  document.addEventListener('close', (e) => {
    if (!(e.target instanceof HTMLDialogElement) || history.state?.dialog !== e.target.id) return;
    ownBack = true;
    history.back();
  }, true);

  window.addEventListener('popstate', () => {
    if (ownBack) { ownBack = false; return; }
    for (const dialog of document.querySelectorAll('dialog[open]')) {
      if (dialog.id !== history.state?.dialog) dialog.close();
    }
  });

  // A click on the dimmed page around a dialog closes it (phones have none:
  // dialogs fill the screen there). Clicks on the backdrop come to the dialog
  // itself, so it's a click outside the dialog's box, pressed and released
  // there, so selecting text and letting go outside doesn't close it.
  const outside = (dialog, e) => {
    const box = dialog.getBoundingClientRect();
    return e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom;
  };
  let pressedOutside = false;
  document.addEventListener('pointerdown', (e) => {
    pressedOutside = e.target instanceof HTMLDialogElement && e.target.open && outside(e.target, e);
  });
  document.addEventListener('click', (e) => {
    const dialog = e.target;
    if (pressedOutside && dialog instanceof HTMLDialogElement && dialog.open && outside(dialog, e)) dialog.close();
    pressedOutside = false;
  });

  // A reload while a dialog was open leaves its entry behind with nothing open.
  if (history.state?.dialog) {
    const { dialog, ...rest } = history.state;
    try { history.replaceState(Object.keys(rest).length ? rest : null, ''); } catch { /* history unavailable */ }
  }
})();
