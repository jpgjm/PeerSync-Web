/**
 * Loads the Material Web components and small helpers used across the page.
 * Only the components in use are imported (not all.js, to keep the download small).
 */
import "@material/web/button/text-button.js";
import "@material/web/dialog/dialog.js";
import "@material/web/fab/fab.js";
import "@material/web/focus/md-focus-ring.js";
import "@material/web/icon/icon.js";
import "@material/web/iconbutton/icon-button.js";
import "@material/web/list/list.js";
import "@material/web/list/list-item.js";
import "@material/web/menu/menu.js";
import "@material/web/menu/menu-item.js";
import "@material/web/progress/circular-progress.js";
import "@material/web/progress/linear-progress.js";
import "@material/web/ripple/ripple.js";
import "@material/web/tabs/tabs.js";
import "@material/web/tabs/primary-tab.js";
import "@material/web/textfield/outlined-text-field.js";
// the navigation bar only exists in labs (experimental)
import "@material/web/labs/navigationbar/navigation-bar.js";
import "@material/web/labs/navigationtab/navigation-tab.js";

import type { MdDialog } from "@material/web/dialog/dialog.js";
import { IconName, iconSvg } from "./icons";

/** Fills <md-icon data-icon="name"> with its SVG (so the HTML doesn't repeat the same SVG). */
export function fillIcons(root: ParentNode = document) {
  for (const el of root.querySelectorAll<HTMLElement>("md-icon[data-icon]")) {
    if (el.childElementCount > 0) continue;
    setIcon(el, el.dataset.icon as IconName);
  }
}

/** Sets or changes the SVG of an <md-icon>. */
export function setIcon(el: HTMLElement, name: IconName) {
  if (el.dataset.icon === name && el.childElementCount > 0) return;
  el.dataset.icon = name;
  el.innerHTML = iconSvg(name);
  el.setAttribute("aria-hidden", "true");
}

/**
 * Keeps the dialog open when the scrim (background) is tapped. Esc still closes it (as cancel).
 * For dialogs with typed input, and decisions the other device is waiting for (pairing, receiving files).
 * md-dialog fires cancel for both a scrim tap and Esc, so the last key decides.
 */
export function keepOpenOnScrim(dialog: MdDialog) {
  let escape = false;
  dialog.addEventListener("keydown", (e) => {
    escape = (e as KeyboardEvent).key === "Escape";
  });
  dialog.addEventListener("cancel", (e) => {
    if (!escape) e.preventDefault();
    escape = false;
  });
}

/** Opens a dialog (clearing the previous returnValue first). */
export function openDialog(dialog: MdDialog) {
  dialog.returnValue = "";
  void dialog.show();
}
