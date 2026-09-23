import { BrowserWindow, Notification, app } from 'electron';

/**
 * Telling the user something happened while they were looking elsewhere.
 *
 * Every other thing this app has to say is a sentence on a row, which is enough because the reader is
 * looking at the row. The unattended chain is the exception: it runs on a poll, it can finish minutes
 * after the tab was last opened, and its interesting moments (a pull request opened, a pass finished,
 * a ticket closed) all happen with nobody watching.
 *
 * ⚠️ **The whole thing rests on the AppUserModelID, and it fails silently when it is wrong.** Windows
 * delivers a toast to a process whose AUMID matches a shortcut installed on the Start Menu. Without
 * that pairing `show()` returns normally and nothing appears: no error, no log, nothing to debug. That
 * is why `app.setAppUserModelId` is called at boot with the same `appId` electron-builder puts on the
 * shortcut, and why the zip build can never notify, however correct this file is.
 *
 * There is deliberately **no setting** for this. Once the AUMID is registered, Windows lists the app in
 * its own notification settings, which is where a person already goes to silence an application; a
 * second switch in here would be a second answer to the same question, and the loser would be whichever
 * one the reader did not think to look at.
 */

/** No `appId` constant of our own: it has to be the one electron-builder wrote into the shortcut. */
const APP_USER_MODEL_ID = 'dev.jpaniagua.oxum-dev-dashboard';

/**
 * Registers the identity Windows delivers toasts against.
 *
 * Called once, before any window exists. Harmless on the other platforms, where Electron ignores it.
 */
export function registerNotificationIdentity(): void {
  app.setAppUserModelId(APP_USER_MODEL_ID);
}

/**
 * Says one thing, and brings the window forward when it is clicked.
 *
 * **The taskbar flash is not a fallback, it fires every time.** A toast can be swallowed with no trace
 * by Focus Assist, by a Do Not Disturb window, by notification settings the user changed months ago, or
 * by the missing shortcut above; `flashFrame` depends on none of that and is the only half of this that
 * cannot silently do nothing. Together they cost one extra line and remove the failure mode where the
 * feature looks broken because Windows decided not to show it.
 *
 * Never throws. A notification that takes the poll down with it would be worse than one nobody sees.
 */
export function notify(title: string, body: string): void {
  const window = BrowserWindow.getAllWindows()[0];
  window?.flashFrame(true);

  if (!Notification.isSupported()) {
    return;
  }
  try {
    const toast = new Notification({ title, body });
    toast.on('click', () => {
      if (window === undefined || window.isDestroyed()) {
        return;
      }
      // The flash is cleared by the act of coming forward: leaving it on after the user has answered
      // is the taskbar still asking for attention it already got.
      window.flashFrame(false);
      if (window.isMinimized()) {
        window.restore();
      }
      window.show();
      window.focus();
    });
    toast.show();
  } catch {
    // Windows can refuse a toast for reasons that have nothing to do with this app, and the flash
    // above has already done the useful half.
  }
}
